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
import { getPreset } from "../providers/presets.ts";
import type { ToolContext } from "../tools/registry.ts";
import { resolveCapabilities } from "../providers/capabilities.ts";

/* --------------------------------------------------------- per session --- */

interface InFlight {
  controller: AbortController;
  promise: Promise<void>;
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
  private readonly tasks: TaskStore;
  private readonly toolRegistry: ToolRegistry;
  private readonly emitEvent: (sessionId: string, e: AgentEvent) => void;

  /** Active loops keyed by sessionId */
  private inFlight = new Map<string, InFlight>();

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
    this.tasks = opts.tasks;
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
  ): Promise<Result<void>> {
    const session = await this.sessions.get(sessionId);
    if (!session) return err(`Session "${sessionId}" not found`);

    // If already running, cancel and wait before starting again
    const existing = this.inFlight.get(sessionId);
    if (existing) {
      existing.controller.abort();
      await existing.promise.catch(() => undefined);
    }

    const controller = new AbortController();
    const loopPromise = this.runLoop(session, text, attachments, controller);
    this.inFlight.set(sessionId, { controller, promise: loopPromise });

    loopPromise.catch(() => undefined).finally(() => {
      this.inFlight.delete(sessionId);
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
    sessionId: string,
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
  ): Promise<void> {
    const sessionId = session.id;

    try {
      await this.sessions.updateStatus(sessionId, "running");
      this.emitEvent(sessionId, { type: "session_status", sessionId, status: "running" });

      const appSettings = await this.settings.get();
      const modeSettings = appSettings[session.mode];
      const { providerId, keyId, modelId } = modeSettings.selection;

      if (!keyId || !providerId || !modelId) {
        throw new Error("No model configured. Please select a provider and model in Settings.");
      }

      // Look up preset to get protocol
      const preset = getPreset(providerId);
      if (!preset) throw new Error(`Unknown provider: "${providerId}"`);

      // Get adapter
      const adapter = this.registry.adapterFor(preset.protocol);

      // Build provider context
      const ctx = await this.registry.contextFor(providerId, keyId);

      // Build history
      const history = await this.sessions.messages(sessionId);

      // Append user turn
      const userMsg: Message = {
        id: `msg_${Date.now().toString(36)}`,
        role: "user",
        content: [{ type: "text", text }],
        createdAt: Date.now(),
      };
      const fullHistory = [...history, userMsg];

      // Build system prompt context
      const memoryContext = await this.memory.loadStartupContext().catch(() => "");
      const allSkills = this.skills.list();

      // Build mcp servers summary
      const mcpServers = this.mcp
        .status()
        .filter((s) => s.status === "connected")
        .map((s) => ({ name: s.name, toolCount: s.toolCount }));

      const visionCapable = looksVisionCapable(modelId, providerId);

      const promptCtx: PromptContext = {
        userName: appSettings.general.userName,
        workDescription: appSettings.general.workDescription,
        customInstructions: appSettings.general.customInstructions,
        workingFolder: session.workingFolder,
        outputsDir: session.workingFolder ?? process.cwd(),
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

      // Build executor
      const executor = makeExecutor(
        this.toolRegistry,
        (sid: string): Omit<ToolContext, "signal" | "onProgress"> => ({
          sessionId: sid,
          mode: session.mode,
          workingFolder: session.workingFolder,
          outputsDir: session.workingFolder ?? process.cwd(),
          capabilities,
          modelId,
          providerId,
        }),
        (mode: Mode) => appSettings[mode],
      );

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
        emit: (e: AgentEvent) => {
          this.emitEvent(sessionId, e);
        },
      });

      // Persist produced messages (user turn + agent turns)
      const produced = [userMsg, ...result.messages];
      await this.sessions.appendMessages(sessionId, produced);

      const finalStatus = result.stopReason === "cancelled" ? "cancelled" : "idle";
      await this.sessions.updateStatus(sessionId, finalStatus);
      this.emitEvent(sessionId, { type: "session_status", sessionId, status: finalStatus });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.sessions.updateStatus(sessionId, "error");
      this.emitEvent(sessionId, {
        type: "error",
        sessionId,
        message: msg,
        recoverable: false,
      });
      this.emitEvent(sessionId, { type: "session_status", sessionId, status: "error" });
    }
  }
}
