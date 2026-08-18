/**
 * SessionManager — coordinates the agent loop for each session.
 *
 * Key design:
 * - Per-session AbortControllers in a Map. cancel() only stops the target session.
 * - Cowork and Code are fully independent: no shared "current session" state.
 * - Events are forwarded to the renderer via the injected emit callback.
 * - AskBroker.resolve() is used for reply() so the agent can pause on questions.
 */

import type {
  AgentEvent,
  Message,
  Mode,
  PermissionMode,
  Session,
} from "../../shared/types.ts";
import { ok, err } from "../../shared/types.ts";
import type { Result } from "../../shared/types.ts";
import type { SessionStore } from "./store.ts";
import type { ProviderRegistry } from "../providers/registry.ts";
import type { SettingsStore } from "../store/settings.ts";
import type { MemoryVault } from "../memory/vault.ts";
import type { SkillStore } from "../skills/index.ts";
import type { McpManager } from "../mcp/manager.ts";
import type { AskBroker } from "../tools/ask.ts";
import type { TaskStore } from "../tools/tasks.ts";
import { runAgentLoop } from "../agent/loop.ts";
import { buildSystemPrompt } from "../agent/prompts/index.ts";
import type { PromptContext } from "../agent/prompts/index.ts";
import { makeExecutor } from "../tools/index.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { looksVisionCapable } from "../providers/capabilities.ts";
import { PROVIDER_PRESETS } from "../providers/presets.ts";
import type { ToolContext } from "../tools/registry.ts";
import { resolveCapabilities } from "../providers/capabilities.ts";
import { checkPermission, blockedResult } from "../tools/permissions.ts";

/* --------------------------------------------------------- per session --- */

interface InFlight {
  controller: AbortController;
  promise: Promise<void>;
  clientTurnId?: string;
}

/* ---------------------------------------------------------------- class --- */

export class SessionManager {
  private readonly sessions: SessionStore;
  private readonly registry: ProviderRegistry;
  private readonly settings: SettingsStore;
  private readonly memory: MemoryVault;
  private readonly skills: SkillStore;
  private readonly mcp: McpManager;
  private readonly ask: AskBroker;
  private readonly toolRegistry: ToolRegistry;
  private readonly emitEvent: (sessionId: string, e: AgentEvent) => void;

  /** Active loops keyed by sessionId */
  private inFlight = new Map<string, InFlight>();
  /** Recently completed client turns; protects delayed renderer retries. */
  private completedTurns = new Map<string, number>();
  private readonly completedTurnTtlMs = 10 * 60_000;

  constructor(opts: {
    sessions: SessionStore;
    registry: ProviderRegistry;
    settings: SettingsStore;
    memory: MemoryVault;
    skills: SkillStore;
    mcp: McpManager;
    ask: AskBroker;
    tasks: TaskStore;
    toolRegistry: ToolRegistry;
    emitEvent: (sessionId: string, e: AgentEvent) => void;
  }) {
    this.sessions = opts.sessions;
    this.registry = opts.registry;
    this.settings = opts.settings;
    this.memory = opts.memory;
    this.skills = opts.skills;
    this.mcp = opts.mcp;
    this.ask = opts.ask;
    this.toolRegistry = opts.toolRegistry;
    this.emitEvent = opts.emitEvent;
  }

  /**
   * Send a user message and start the agent loop.
   * Returns immediately after queueing; events stream via emitEvent.
   */
  async send(
    sessionId: string,
    text: string,
    attachments: string[] = [],
    clientTurnId?: string,
  ): Promise<Result<void>> {
    const session = await this.sessions.get(sessionId);
    if (!session) return err(`Session "${sessionId}" not found`);

    // A renderer retry can arrive after the original run reached its terminal
    // event but before the UI received the acknowledgement. Treat it as a
    // no-op for a short window, just like a duplicate that arrived in-flight.
    if (clientTurnId) {
      const completedAt = this.completedTurns.get(`${sessionId}:${clientTurnId}`);
      if (completedAt !== undefined) {
        if (Date.now() - completedAt < this.completedTurnTtlMs) return ok(undefined);
        this.completedTurns.delete(`${sessionId}:${clientTurnId}`);
      }
    }

    // Never cancel a healthy autonomous run just because a second submit
    // arrived. Same clientTurnId is an idempotent retry; a different turn is
    // rejected until the current run reaches a terminal status.
    const existing = this.inFlight.get(sessionId);
    if (existing) {
      if (clientTurnId && existing.clientTurnId === clientTurnId) return ok(undefined);
      return err("This session is already running. Wait for it to finish or cancel it explicitly.");
    }

    const controller = new AbortController();
    const loopPromise = this.runLoop(session, text, attachments, controller, clientTurnId);
    this.inFlight.set(sessionId, { controller, promise: loopPromise, clientTurnId });

    loopPromise.catch(() => undefined).finally(() => {
      this.inFlight.delete(sessionId);
      if (clientTurnId) {
        const key = `${sessionId}:${clientTurnId}`;
        this.completedTurns.set(key, Date.now());
        // Keep the map bounded even when a long-lived app receives many turns.
        const cutoff = Date.now() - this.completedTurnTtlMs;
        for (const [storedKey, completedAt] of this.completedTurns) {
          if (completedAt < cutoff) this.completedTurns.delete(storedKey);
        }
      }
    });

    return ok(undefined);
  }

  /** Cancel a running loop. */
  async cancel(sessionId: string): Promise<Result<void>> {
    const inf = this.inFlight.get(sessionId);
    if (!inf) return ok(undefined); // not running, that's fine
    inf.controller.abort();
    await inf.promise.catch(() => undefined);
    return ok(undefined);
  }

  /** Resolve a pending ask/question. */
  async reply(
    _sessionId: string,
    requestId: string,
    answer: string | string[],
  ): Promise<Result<void>> {
    const values = Array.isArray(answer) ? answer : [answer];
    const resolved = this.ask.resolve(requestId, values);
    if (!resolved) return err(`No pending request "${requestId}"`);
    return ok(undefined);
  }

  /* -------------------------------------------------------------- loop --- */

  private async runLoop(
    session: Session,
    text: string,
    _attachments: string[],
    controller: AbortController,
    clientTurnId?: string,
  ): Promise<void> {
    const sessionId = session.id;

    try {
      await this.sessions.updateStatus(sessionId, "running");
      this.emitEvent(sessionId, { type: "session_status", mode: session.mode, sessionId, status: "running" });

      const appSettings = await this.settings.get();
      const modeSettings = appSettings[session.mode];
      let { providerId, keyId, modelId } = modeSettings.selection;

      if ((!providerId || !modelId) && session.selection) {
        providerId = providerId || session.selection.providerId;
        keyId = keyId || session.selection.keyId;
        modelId = modelId || session.selection.modelId;
      }

      // Renderer state can be empty or stale on the first turn after startup.
      // Resolve from the encrypted key store as the final source of truth.
      if (!providerId) {
        for (const preset of PROVIDER_PRESETS) {
          const candidateKeyId = await this.registry.resolveKeyId(preset.id, null);
          if (candidateKeyId) {
            providerId = preset.id;
            keyId = candidateKeyId;
            break;
          }
        }
      }

      if (!providerId) {
        throw new Error("No provider configured. Please select a provider and model.");
      }

      let resolvedKeyId = await this.registry.resolveKeyId(providerId, keyId);
      if (!resolvedKeyId) {
        // A stale provider selection should not hide a valid key saved for another provider.
        for (const preset of PROVIDER_PRESETS) {
          const candidateKeyId = await this.registry.resolveKeyId(preset.id, null);
          if (candidateKeyId) {
            providerId = preset.id;
            resolvedKeyId = candidateKeyId;
            break;
          }
        }
      }
      if (!resolvedKeyId) {
        throw new Error(`No API key found for provider "${providerId}". Please add an API key.`);
      }

      if (!modelId) {
        const cachedModels = await this.registry.listModels(providerId).catch(() => []);
        modelId = cachedModels[0]?.id ?? (await this.registry.presetFor(providerId))?.staticModels?.[0] ?? "";
        if (!modelId) {
          const refreshedModels = await this.registry.refreshModels(providerId, resolvedKeyId).catch(() => []);
          modelId = refreshedModels[0]?.id ?? "";
        }
      }

      if (!modelId) {
        throw new Error("No model configured. Please select a model.");
      }

      // Look up preset to get protocol
      const preset = await this.registry.presetFor(providerId);
      if (!preset) throw new Error(`Unknown provider: "${providerId}"`);

      // Get adapter
      const adapter = this.registry.adapterFor(preset.protocol);

      // Build provider context
      const ctx = await this.registry.contextFor(providerId, resolvedKeyId);

      // Build history
      const history = await this.sessions.messages(sessionId);

      // Append user turn
      const userMsg: Message = {
        id: clientTurnId ? `msg_${clientTurnId}` : `msg_${Date.now().toString(36)}`,
        role: "user",
        content: [{ type: "text", text }],
        createdAt: Date.now(),
      };
      const fullHistory = [...history, userMsg];

      // Build system prompt context
      const memoryContext = await this.memory.loadStartupContext().catch(() => "");
      const rulesText = await this.memory.getRules().catch(() => "");
      const allSkills = this.skills.list();

      // Build mcp servers summary
      const mcpServers = this.mcp
        .status()
        .filter((s) => s.status === "connected")
        .map((s) => ({ name: s.name, toolCount: s.toolCount }));

      const visionCapable = looksVisionCapable(modelId, providerId);

      // Resolve working folder: session's own folder, then mode default, then cwd.
      const modeDefaultFolder = appSettings.general.defaultFolders[session.mode] ?? null;
      const resolvedWorkingFolder = session.workingFolder ?? modeDefaultFolder;

      const promptCtx: PromptContext = {
        userName: appSettings.general.userName,
        workDescription: appSettings.general.workDescription,
        customInstructions: appSettings.general.customInstructions,
        rules: rulesText,
        workingFolder: resolvedWorkingFolder,
        outputsDir: resolvedWorkingFolder ?? process.cwd(),
        memoryContext,
        projectKbSummary: "",
        modelId,
        providerId,
        visionCapable,
        computerUseEnabled: appSettings.computerUse.enabled,
        browserEnabled: appSettings.browser.enabled,
        availableSkills: allSkills
          .filter((s) => s.enabled && s.modes.includes(session.mode))
          .map((s) => ({ name: s.name, description: s.description })),
        mcpServers,
        subagents: [],
        now: new Date(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        language: appSettings.general.language,
      };

      const systemPrompt = buildSystemPrompt(
        session.mode,
        promptCtx,
        modeSettings.systemPromptOverride ?? null,
      );

      // Build capabilities for tool context
      const { capabilities } = resolveCapabilities(modelId, providerId);

      // Build executor — use the resolved working folder
      const baseExecutor = makeExecutor(
        this.toolRegistry,
        (sid: string): Omit<ToolContext, "signal" | "onProgress"> => ({
          sessionId: sid,
          mode: session.mode,
          workingFolder: resolvedWorkingFolder,
          outputsDir: resolvedWorkingFolder ?? process.cwd(),
          capabilities,
          modelId,
          providerId,
        }),
        (mode: Mode) => appSettings[mode],
      );

      // Wrap with permission gate.
      const permissionMode: PermissionMode = session.permissionMode;
      const askBroker = this.ask;
      const emitForPermission = this.emitEvent.bind(this);
      const executor = {
        list: baseExecutor.list.bind(baseExecutor),
        async execute(
          name: string,
          input: unknown,
          opts: { sessionId: string; signal: AbortSignal; onProgress: (n: string) => void },
        ) {
          // Look up the tool's group from the registry for permission classification.
          const toolDef = baseExecutor.list(session.mode).find((d) => d.name === name);
          const group = toolDef?.group ?? "system";

          const decision = await checkPermission({
            toolName: name,
            toolGroup: group,
            permissionMode,
            sessionId: opts.sessionId,
            requestPermission: async (requestId: string, reason: string) => {
              emitForPermission(opts.sessionId, {
                type: "permission_request",
                mode: session.mode,
                sessionId: opts.sessionId,
                requestId,
                toolName: name,
                input,
                reason,
              });
              // Wait for the user to reply via AskBroker
              return new Promise<string[]>((resolve, reject) => {
                // The user's reply comes via sessions:reply → AskBroker.resolve(requestId, [answer]).
                // We must register the SAME requestId we emitted above (`ask()` would allocate
                // a fresh id that `sessions:reply` could never resolve), so use registerPending.
                const promise = askBroker.registerPending(requestId, {
                  question: reason,
                  options: [
                    { label: "Allow", value: "yes" },
                    { label: "Deny", value: "no" },
                  ],
                  multiSelect: false,
                });
                void promise.then(resolve).catch(reject);

                // Abort support
                if (opts.signal.aborted) {
                  reject(new Error("Cancelled"));
                  return;
                }
                opts.signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
              });
            },
          });

          if (!decision.allowed) {
            return blockedResult(decision.blockedMessage!);
          }

          return baseExecutor.execute(name, input, opts);
        },
      };

      // Run the agent loop
      const result = await runAgentLoop({
        sessionId,
        mode: session.mode,
        adapter,
        ctx,
        model: modelId,
        system: systemPrompt,
        history: fullHistory,
        tools: executor,
        maxTokens: modeSettings.maxTokens,
        temperature: modeSettings.temperature,
        maxIterations: modeSettings.maxIterations,
        signal: controller.signal,
        // Forward events to the renderer and persist a sidecar for reattachment.
        emit: (e: AgentEvent) => {
          this.emitEvent(sessionId, e);
          void this.sessions.appendRunEvent(sessionId, e);
        },
      });

      // Persist produced messages (user turn + agent turns)
      const produced = [userMsg, ...result.messages];
      await this.sessions.appendMessages(sessionId, produced);

      const finalStatus = result.stopReason === "cancelled" ? "cancelled" : "idle";
      await this.sessions.updateStatus(sessionId, finalStatus);
      this.emitEvent(sessionId, { type: "session_status", mode: session.mode, sessionId, status: finalStatus });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Mirror to stdout so failures are visible in dev logs even if the
      // renderer never receives the IPC event.
      console.error(`[${session.mode}] session run failed:`, msg);
      await this.sessions.updateStatus(sessionId, "error");
      this.emitEvent(sessionId, {
        type: "error",
        mode: session.mode,
        sessionId,
        message: msg,
        recoverable: false,
      });
      this.emitEvent(sessionId, { type: "session_status", mode: session.mode, sessionId, status: "error" });
    }
  }
}
