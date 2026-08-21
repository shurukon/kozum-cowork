/**
 * Kozum Cowork — tool bootstrap.
 *
 * Assembles every built-in tool into one registry. This is the only place that
 * knows the full inventory, and it takes its collaborators by injection so the
 * whole surface can be stood up against temp directories in a test.
 *
 * Mode assignment is deliberate rather than uniform:
 *   - Scheduled tasks are Cowork-only. Recurring unattended work is the thing
 *     that distinguishes Cowork from Code in this product.
 *   - Everything else is shared, because a coding session legitimately needs to
 *     browse, and a creative session legitimately needs a shell.
 */

import type { Mode, ModeSettings, ToolDefinition } from "../../shared/types.ts";
import { blockedResult } from "./permissions.ts";
import { ToolRegistry, type Tool, type ToolContext } from "./registry.ts";

import { fsTools } from "./fs.ts";
import { dirTools } from "./dir.ts";
import { envTools } from "./env.ts";
import { shellTools } from "./shell.ts";
import { jobTools } from "./jobs.ts";
import { processTools } from "./process.ts";
import { systemTools } from "./system.ts";
import { webTools } from "./web.ts";
import { screenshotTools } from "./screenshot.ts";
import { makeTaskTools, TaskStore } from "./tasks.ts";
import { AskBroker, makeAskTools } from "./ask.ts";
import { makeSubagentTools, SubagentManager } from "../agent/subagents.ts";
import { makeSkillTools, SkillStore } from "../skills/index.ts";
import { makeMemoryTools } from "./memory.ts";
import { MemoryVault } from "../memory/vault.ts";
import { makeProjectKb } from "../memory/projectKb.ts";
import { makeScheduleTools } from "./schedule.ts";
import { Scheduler } from "../schedule/scheduler.ts";
import { makeMcpTools } from "./mcp.ts";
import { McpManager } from "../mcp/manager.ts";
import { makePluginTools } from "./plugins.ts";
import { PluginManager } from "../plugins/manager.ts";
import { makeBrowserTools } from "./browser.ts";
import { BrowserEngine } from "../browser/engine.ts";
import { makeComputerTools } from "./computer.ts";
import { PowerShellComputerBackend } from "../computer/windows.ts";
import { X11ComputerBackend } from "../computer/x11.ts";

export interface ToolServices {
  tasks: TaskStore;
  ask: AskBroker;
  subagents: SubagentManager;
  skills: SkillStore;
  memory: MemoryVault;
  scheduler: Scheduler;
  mcp: McpManager;
  plugins: PluginManager;
  browser: BrowserEngine;
  getComputerBlocklist: () => string[];
}

/**
 * Build the full registry.
 *
 * Registration order determines nothing functionally — `list()` sorts by name —
 * but is grouped by concern to keep the inventory readable.
 */
export function buildToolRegistry(svc: ToolServices): ToolRegistry {
  const registry = new ToolRegistry();

  // Filesystem and environment.
  registry.registerAll(fsTools);
  registry.registerAll(dirTools);
  registry.registerAll(envTools);

  // Shell, background jobs, processes, host info.
  registry.registerAll(shellTools);
  registry.registerAll(jobTools);
  registry.registerAll(processTools);
  registry.registerAll(systemTools);

  // Network and rendering.
  registry.registerAll(webTools);
  registry.registerAll(screenshotTools);

  // Agent self-management.
  registry.registerAll(makeTaskTools(svc.tasks));
  registry.registerAll(makeAskTools(svc.ask));
  registry.registerAll(makeSubagentTools(svc.subagents));
  registry.registerAll(makeSkillTools(svc.skills));

  // Persistent knowledge.
  registry.registerAll(makeMemoryTools(svc.memory, makeProjectKb(svc.memory.root)));

  // Recurring work — Cowork only, by design.
  registry.registerAll(makeScheduleTools(svc.scheduler));

  // Extensibility. These two are the product's differentiator: the agent
  // installs its own connectors and plugins, with no manual file editing and
  // no restart.
  registry.registerAll(makeMcpTools(svc.mcp));
  registry.registerAll(makePluginTools(svc.plugins));

  // Direct control surfaces.
  registry.registerAll(makeBrowserTools(svc.browser));
  const computerBackend = process.platform === "linux" && process.env.DISPLAY
    ? new X11ComputerBackend()
    : new PowerShellComputerBackend();
  registry.registerAll(makeComputerTools(computerBackend, svc.getComputerBlocklist));

  return registry;
}

/**
 * Adapts a registry to the agent loop's `ToolExecutor`, binding the per-session
 * context the loop does not carry.
 */
export function makeExecutor(
  registry: ToolRegistry,
  getContext: (sessionId: string) => Omit<ToolContext, "signal" | "onProgress" | "onQuestion">,
  getModeSettings: (mode: Mode) => ModeSettings,
) {
  return {
    list(mode: Mode): ToolDefinition[] {
      return registry.list(mode, getModeSettings(mode).enabledToolNames);
    },

    execute(
      name: string,
      input: unknown,
      opts: {
        sessionId: string;
        signal: AbortSignal;
        onProgress: (n: string) => void;
        onQuestion?: NonNullable<ToolContext["onQuestion"]>;
      },
    ) {
      const base = getContext(opts.sessionId);
      const enabled = getModeSettings(base.mode).enabledToolNames;
      if (enabled !== null && !enabled.includes(name)) {
        return Promise.resolve(
          blockedResult(
            `The tool "${name}" is disabled for ${base.mode} mode and was not executed.`,
          ),
        );
      }
      return registry.execute(name, input, {
        ...base,
        signal: opts.signal,
        onProgress: opts.onProgress,
        onQuestion: opts.onQuestion,
      });
    },
  };
}

/** Every tool bundled with the app, for the Settings inventory. */
export function allToolNames(svc: ToolServices): string[] {
  return buildToolRegistry(svc).names();
}

export type { Tool, ToolContext };
export { ToolRegistry };
