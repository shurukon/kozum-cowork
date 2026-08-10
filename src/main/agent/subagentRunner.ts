/**
 * Subagent runner — the real AgentRunner wired up after SessionManager exists.
 *
 * Mirrors SessionManager.runLoop's adapter/ctx/executor construction but for an
 * ISOLATED history: the subagent sees only its own spec.prompt, never the
 * parent transcript (consistency with the `<subagents>` system-prompt promise).
 * Fire-and-forget — the manager forwards `subagent_*` events to the parent
 * renderer so it can show a live progress card. The run honours `spec.signal`,
 * which the manager aborts on `agent_cancel`.
 */

import type { Message, Mode, TokenUsage } from "../../shared/types.ts";
import type { ProviderRegistry } from "../providers/registry.ts";
import type { SettingsStore } from "../store/settings.ts";
import type { MemoryVault } from "../memory/vault.ts";
import type { SkillStore } from "../skills/index.ts";
import type { McpManager } from "../mcp/manager.ts";
import type { ToolRegistry, ToolContext } from "../tools/registry.ts";
import { makeExecutor } from "../tools/index.ts";
import { runAgentLoop } from "./loop.ts";
import { buildSystemPrompt } from "./prompts/index.ts";
import type { PromptContext } from "./prompts/index.ts";
import { getPreset } from "../providers/presets.ts";
import { resolveCapabilities, looksVisionCapable } from "../providers/capabilities.ts";
import type { AgentRunner } from "./subagents.ts";

export interface SubagentRunnerDeps {
  registry: ProviderRegistry;
  settings: SettingsStore;
  memory: MemoryVault;
  skills: SkillStore;
  mcp: McpManager;
  toolRegistry: ToolRegistry;
  /**
   * Forward a subagent lifecycle event to the parent session's renderer.
   * The manager owns all `subagent_*` emissions; the runner only needs to
   * surface per-tool progress so the UI can render a live progress bar.
   */
  bumpProgress?: (runId: string, note: string, progress?: number) => void;
}

function summarise(messages: Message[]): string {
  const assistantText = messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.content)
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text);
  return assistantText.join("\n").trim() || "(subagent produced no text)";
}

export function makeRealRunner(deps: SubagentRunnerDeps): AgentRunner {
  return async (spec): Promise<{ text: string; usage?: TokenUsage }> => {
    const signal = spec.signal;
    const bump = (note: string, progress?: number) =>
      deps.bumpProgress?.(spec.id, note, progress);

    const appSettings = await deps.settings.get();
    const modeSettings = appSettings["cowork"];
    const mode: Mode = "cowork";
    let { providerId, keyId, modelId } = modeSettings.selection;

    if (!providerId) {
      throw new Error("Subagent run aborted: no provider configured.");
    }

    const resolvedKeyId = await deps.registry.resolveKeyId(providerId, keyId);
    if (!resolvedKeyId) {
      throw new Error(`Subagent run aborted: no API key for provider "${providerId}".`);
    }
    if (!modelId) {
      throw new Error("Subagent run aborted: no model configured.");
    }

    const preset = getPreset(providerId);
    if (!preset) throw new Error(`Subagent run aborted: unknown provider "${providerId}".`);

    const adapter = deps.registry.adapterFor(preset.protocol);
    const ctx = await deps.registry.contextFor(providerId, resolvedKeyId);

    const history: Message[] = [
      {
        id: `subagent_${spec.id}_user`,
        role: "user",
        content: [{ type: "text", text: spec.prompt }],
        createdAt: Date.now(),
      },
    ];

    const memoryContext = await deps.memory.loadStartupContext().catch(() => "");
    const rulesText = await deps.memory.getRules().catch(() => "");
    const mcpServers = deps.mcp
      .status()
      .filter((s) => s.status === "connected")
      .map((s) => ({ name: s.name, toolCount: s.toolCount }));

    const visionCapable = looksVisionCapable(modelId, providerId);
    const workingFolder = appSettings.general.defaultFolders.cowork ?? null;

    const promptCtx: PromptContext = {
      userName: appSettings.general.userName,
      workDescription: appSettings.general.workDescription,
      customInstructions: appSettings.general.customInstructions,
      rules: rulesText,
      workingFolder,
      outputsDir: workingFolder ?? process.cwd(),
      memoryContext,
      projectKbSummary: "",
      modelId,
      providerId,
      visionCapable,
      computerUseEnabled: false,
      browserEnabled: appSettings.browser.enabled,
      availableSkills: deps.skills
        .list()
        .filter((s) => s.enabled && s.modes.includes(mode))
        .map((s) => ({ name: s.name, description: s.description })),
      mcpServers,
      subagents: [],
      now: new Date(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      language: appSettings.general.language,
    };

    const systemPrompt =
      spec.systemPrompt.trim() ||
      buildSystemPrompt("cowork", promptCtx, null);

    const { capabilities } = resolveCapabilities(modelId, providerId);

    const executor = makeExecutor(
      deps.toolRegistry,
      (_sid: string): Omit<ToolContext, "signal" | "onProgress"> => ({
        sessionId: spec.id,
        mode,
        workingFolder,
        outputsDir: workingFolder ?? process.cwd(),
        capabilities,
        modelId,
        providerId,
      }),
      (m: Mode) => appSettings[m],
    );

    const result = await runAgentLoop({
      sessionId: spec.id,
      mode,
      adapter,
      ctx,
      model: modelId,
      system: systemPrompt,
      history,
      tools: executor,
      maxTokens: modeSettings.maxTokens,
      temperature: modeSettings.temperature,
      maxIterations: modeSettings.maxIterations,
      signal,
      // Map the subagent's internal loop events onto parent-visible progress.
      emit: (e) => {
        switch (e.type) {
          case "tool_start":
            bump(`working: ${e.name}`);
            break;
          case "tool_progress":
          case "tool_end":
            bump("working");
            break;
          case "turn_end":
            bump("finished turn", 1.0);
            break;
          default:
            break;
        }
      },
      // Live tool progress also flows through onProgress for the manager's bar.
      // (runAgentLoop forwards each tool call's progress to bumpProgress.)
    });

    return { text: summarise(result.messages), usage: result.usage };
  };
}
