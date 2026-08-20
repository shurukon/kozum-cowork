/**
 * Subagent tools — launch background agents and track their runs.
 *
 * SubagentManager wraps a user-supplied `runner` callback so the implementation
 * is fully testable without a real LLM provider. Runs are tracked in memory per
 * manager instance; a concurrency cap (default 4) queues beyond that.
 */

import type { Mode, SubagentRun, AgentEvent, TokenUsage } from "../../shared/types.ts";
import type { Tool } from "../tools/registry.ts";
import { ok, fail } from "../tools/registry.ts";
import type { TaskStore } from "../tools/tasks.ts";
import { parseFrontmatter } from "./frontmatter.ts";

/* -------------------------------------------------------------- runner ---- */

export interface RunnerSpec {
  id: string;
  name: string;
  mode: Mode;
  systemPrompt: string;
  prompt: string;
  model?: string;
  tools?: string[];
  /** Explicit checks the parent must verify before accepting the delegation. */
  acceptanceCriteria?: string[];
  /** AgentTask id used to track this delegated outcome in the parent session. */
  taskId?: string;
  /** Abort signal the run must honour; the manager aborts it on cancel(). */
  signal: AbortSignal;
}

export type AgentRunner = (
  spec: RunnerSpec & { signal: AbortSignal },
) => Promise<{ text: string; usage?: TokenUsage }>;

/* ---------------------------------------------------- run handle (P1-1) --- */

interface RunHandle {
  run: SubagentRun;
  mode: Mode;
  controller: AbortController;
  /** Last progress note, local-only (not part of the wire `SubagentRun`). */
  note?: string;
}

/* ----------------------------------------------------------- id gen ---- */

let seq = 0;
function runMode(handle: RunHandle): Mode {
  return handle.mode;
}

function newRunId(): string {
  seq += 1;
  return `agent_${Date.now().toString(36)}_${seq.toString(36)}`;
}

/* ---------------------------------------------------- SubagentManager ---- */

export class SubagentManager {
  private runs = new Map<string, RunHandle>();
  private active = 0;
  private readonly concurrencyLimit: number;
  private queue: Array<() => void> = [];
  private runner: AgentRunner;
  private readonly taskStore?: TaskStore;
  /** Bridges subagent lifecycle events to the parent session's renderer (P1-1). */
  private emit?: (sessionId: string, e: AgentEvent) => void;

  constructor(runner: AgentRunner, concurrencyLimit = 4, taskStore?: TaskStore) {
    this.runner = runner;
    this.concurrencyLimit = concurrencyLimit;
    this.taskStore = taskStore;
  }

  /**
   * Replace the runner used for future `launch()` calls.
   *
   * The Deferred-construction pattern: index.ts instantiates the manager with a
   * stub runner so tool wiring can reference it, then calls setRunner with the
   * real provider-backed runner once SessionManager (and the provider registry
   * it owns) has been built. This avoids a circular dependency.
   */
  setRunner(runner: AgentRunner): void {
    this.runner = runner;
  }

  /** Register the emitter that forwards subagent events to the parent UI. */
  setEmitter(emit: (sessionId: string, e: AgentEvent) => void): void {
    this.emit = emit;
  }

  /** Launch a run immediately (fire-and-forget). Returns the run id. */
  launch(
    parentSessionId: string,
    name: string,
    description: string,
    systemPrompt: string,
    prompt: string,
    model?: string,
    tools?: string[],
    parentMessageId?: string,
    mode: Mode = "cowork",
    acceptanceCriteria: string[] = [],
    taskId?: string,
  ): string {
    const id = newRunId();
    const controller = new AbortController();
    this.taskStore?.setMode(parentSessionId, mode);
    const normalizedCriteria = acceptanceCriteria.map((criterion) => criterion.trim()).filter(Boolean);
    const trackedTask = taskId
      ? this.taskStore?.get(parentSessionId, taskId)
      : this.taskStore?.create(
          parentSessionId,
          `Delegated: ${name}`,
          `${description}\n\nAcceptance criteria:\n${normalizedCriteria.length ? normalizedCriteria.map((criterion) => `- ${criterion}`).join("\n") : "- Parent verification required."}`,
          "in_progress",
        );
    const run: SubagentRun = {
      id,
      parentSessionId,
      parentMessageId,
      taskId: trackedTask?.id ?? taskId,
      name,
      description,
      status: "running",
      startedAt: Date.now(),
      acceptanceCriteria: normalizedCriteria,
      progress: 0,
    };
    const handle: RunHandle = { run, controller, mode };
    this.runs.set(id, handle);

    // Announce the run to the parent's renderer immediately (P1-1 / D1).
    this.emit?.(parentSessionId, {
      type: "subagent_start",
      mode,
      sessionId: parentSessionId,
      parentMessageId,
      run,
      runId: id,
    });

    this.schedule(() =>
      this.executeRun(id, systemPrompt, prompt, model, tools, controller.signal),
    );

    return id;
  }

  /**
   * Record live progress for a run and forward it to the parent renderer.
   * Called by the runner on every `tool_*` event inside the subagent loop.
   */
  bumpProgress(id: string, note: string, progress?: number): void {
    const handle = this.runs.get(id);
    if (!handle) return;
    handle.note = note;
    handle.run = {
      ...handle.run,
      currentStep: note,
      ...(progress !== undefined ? { progress } : {}),
    };
    if (handle.run.taskId) {
      this.taskStore?.setMode(handle.run.parentSessionId, handle.mode);
      this.taskStore?.update(handle.run.parentSessionId, handle.run.taskId, {
        status: "in_progress",
        description: `${handle.run.description}\n\nCurrent step: ${note}`,
      });
    }
    this.emit?.(handle.run.parentSessionId, {
      type: "subagent_progress",
      mode: runMode(handle),
      sessionId: handle.run.parentSessionId,
      runId: id,
      note,
      ...(progress !== undefined ? { progress } : {}),
    });
  }

  private schedule(work: () => void): void {
    if (this.active < this.concurrencyLimit) {
      this.active++;
      work();
    } else {
      this.queue.push(work);
    }
  }

  private onFinish(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.active--;
    }
  }

  private executeRun(
    id: string,
    systemPrompt: string,
    prompt: string,
    model?: string,
    tools?: string[],
    signal?: AbortSignal,
  ): void {
    const handle = this.runs.get(id);
    if (!handle) return;

    const spec: RunnerSpec = {
      id,
      name: handle.run.name,
      mode: handle.mode,
      systemPrompt,
      prompt,
      signal: signal ?? new AbortController().signal,
      acceptanceCriteria: handle.run.acceptanceCriteria,
      taskId: handle.run.taskId,
      ...(model !== undefined ? { model } : {}),
      ...(tools !== undefined ? { tools } : {}),
    };

    const done = (run: SubagentRun) => {
      // Cancellation emits the terminal event synchronously. The runner may
      // reject afterwards, so ignore that late settlement rather than emitting
      // a second end event or changing cancelled into failed.
      if (handle.run.status !== "running") return;
      handle.run = run;
      if (run.taskId) {
        this.taskStore?.setMode(run.parentSessionId, handle.mode);
        this.taskStore?.update(run.parentSessionId, run.taskId, {
          status: run.status === "completed" ? "completed" : run.status === "cancelled" ? "stopped" : "failed",
          description: `${run.description}${run.result ? `\n\nResult:\n${run.result}` : run.error ? `\n\nError:\n${run.error}` : ""}`,
        });
      }
      this.emit?.(run.parentSessionId, {
        type: "subagent_end",
        mode: runMode(handle),
        sessionId: run.parentSessionId,
        runId: id,
        status: run.status === "running" ? "completed" : (run.status as "completed" | "failed" | "cancelled"),
        ...(run.result !== undefined ? { result: run.result } : {}),
        ...(run.error !== undefined ? { error: run.error } : {}),
      });
    };

    this.runner(spec)
      .then((result) => {
        done({
          ...handle.run,
          status: "completed",
          endedAt: Date.now(),
          result: result.text,
          usage: result.usage,
        });
      })
      .catch((err: unknown) => {
        // An abort surfaces as a rejection; normalise to the cancelled state.
        const aborted = signal?.aborted ?? false;
        const message = err instanceof Error ? err.message : String(err);
        done({
          ...handle.run,
          status: aborted ? "cancelled" : "failed",
          endedAt: Date.now(),
          error: message,
        });
      })
      .finally(() => {
        this.onFinish();
      });
  }

  getStatus(id: string): SubagentRun | undefined {
    return this.runs.get(id)?.run;
  }

  getHandle(id: string): RunHandle | undefined {
    return this.runs.get(id);
  }

  listAll(): SubagentRun[] {
    return [...this.runs.values()].map((h) => h.run);
  }

  listForSession(parentSessionId: string, mode?: Mode): SubagentRun[] {
    return [...this.runs.values()]
      .filter((h) => h.run.parentSessionId === parentSessionId && (mode === undefined || h.mode === mode))
      .map((h) => h.run);
  }

  /**
   * Cancel a running subagent. Aborts the run's AbortController so the in-flight
   * LLM call terminates, marks the run cancelled, and notifies the parent (D2).
   */
  cancel(id: string): boolean {
    const handle = this.runs.get(id);
    if (!handle || handle.run.status !== "running") return false;
    handle.controller.abort();
    handle.run = {
      ...handle.run,
      status: "cancelled",
      endedAt: Date.now(),
      currentStep: "cancelled",
    };
    if (handle.run.taskId) {
      this.taskStore?.setMode(handle.run.parentSessionId, handle.mode);
      this.taskStore?.update(handle.run.parentSessionId, handle.run.taskId, {
        status: "stopped",
        description: `${handle.run.description}\n\nCancelled by parent.` ,
      });
    }
    this.emit?.(handle.run.parentSessionId, {
      type: "subagent_end",
      mode: runMode(handle),
      sessionId: handle.run.parentSessionId,
      runId: id,
      status: "cancelled",
    });
    return true;
  }
}

/* ----------------------------------------------------- subagent tools ---- */

export function makeSubagentTools(manager: SubagentManager): Tool[] {
  return [
    /* --------------------------------------------------------- agent_run */
    {
      definition: {
        name: "agent_run",
        title: "Run Subagent",
        description:
          "Launch a background subagent to work on a self-contained task. Returns " +
          "an agent id immediately — the agent runs asynchronously. Use agent_status " +
          "to poll for completion. Keep description to 3–5 words.",
        inputSchema: {
          type: "object",
          properties: {
            description: {
              type: "string",
              description: "Short task label, 3–5 words (used as the run name).",
            },
            prompt: {
              type: "string",
              description:
          "Full, self-contained task prompt. Include the goal, constraints, files " +
                  "or inputs, and acceptance checks. The subagent has no parent transcript.",
            },
            model: {
              type: "string",
              description: "Optional model id override for this run.",
            },
            acceptance_criteria: {
              type: "array",
              description: "Concrete checks the parent must verify before accepting this run.",
              items: { type: "string", description: "One observable acceptance check." },
            },
            isolation: {
              type: "boolean",
              description: "Run with an isolated prompt/history (default: true).",
            },
          },
          required: ["description", "prompt", "acceptance_criteria"],
        },
        icon: "bot",
        group: "agent",
        modes: ["cowork", "code"],
      },
      async handler(input, ctx) {
        const description = String(input["description"] ?? "").trim();
        const prompt = String(input["prompt"] ?? "").trim();
        const model = input["model"] !== undefined ? String(input["model"]) : undefined;
        const acceptanceCriteria = Array.isArray(input["acceptance_criteria"])
          ? input["acceptance_criteria"].filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean)
          : [];
        if (!description || !prompt || acceptanceCriteria.length === 0) {
          return fail("agent_run requires description, prompt, and at least one acceptance_criteria item.");
        }

        const id = manager.launch(
          ctx.sessionId,
          description,
          description,
          "",
          prompt,
          model,
          undefined,
          undefined,
          ctx.mode,
          acceptanceCriteria,
        );

        const run = manager.getStatus(id);
        return ok(
          `Subagent launched. id: ${id}\n` +
            `Tracking task: ${run?.taskId ?? "none"}\n` +
            `Acceptance criteria:\n${acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}\n` +
            `You can poll \`agent_status\` for completion. To cancel, call \`agent_cancel\` with the id.`,
          { summary: `Subagent launched: ${description}` },
        );
      },
    },

    /* ----------------------------------------------------- agent_cancel */
    {
      definition: {
        name: "agent_cancel",
        title: "Cancel Subagent",
        description:
          "Abort a running subagent by id. Use this when a subagent has gone " +
          "off-topic or is no longer needed; its in-flight work is terminated " +
          "immediately. Returns whether the cancel took effect.",
        inputSchema: {
          type: "object",
          properties: {
            agentId: {
              type: "string",
              description: "The agent id returned by agent_run.",
            },
          },
          required: ["agentId"],
        },
        icon: "square",
        group: "agent",
        modes: ["cowork", "code"],
      },
      async handler(input, ctx) {
        const agentId = String(input["agentId"] ?? "").trim();
        if (!agentId) {
          return fail("agent_cancel requires an `agentId`.");
        }
        const existing = manager.getStatus(agentId);
        if (existing && (existing.parentSessionId !== ctx.sessionId || !manager.listForSession(ctx.sessionId, ctx.mode).some((run) => run.id === agentId))) {
          return fail(`No subagent run found with id "${agentId}" in this session.`);
        }
        const cancelled = manager.cancel(agentId);
        if (!cancelled) {
          const run = manager.getStatus(agentId);
          return ok(
            run
              ? `Agent ${agentId} was not running (status: ${run.status}). Nothing to cancel.`
              : `No subagent run found with id "${agentId}".`,
            { summary: `Agent ${agentId}: nothing to cancel` },
          );
        }
        return ok(
          `Subagent ${agentId} cancelled. Its in-flight work was terminated.`,
          { summary: `Subagent cancelled: ${agentId}` },
        );
      },
    },

    /* ------------------------------------------------------ agent_status */
    {
      definition: {
        name: "agent_status",
        title: "Agent Status",
        description: "Check the status of a running or completed subagent run.",
        inputSchema: {
          type: "object",
          properties: {
            agentId: {
              type: "string",
              description: "The agent id returned by agent_run.",
            },
          },
          required: ["agentId"],
        },
        icon: "activity",
        group: "agent",
        modes: ["cowork", "code"],
      },
      async handler(input, ctx) {
        const agentId = String(input["agentId"] ?? "").trim();
        const run = manager.listForSession(ctx.sessionId, ctx.mode).find((candidate) => candidate.id === agentId);
        if (!run) {
          return fail(`No subagent run found with id "${agentId}". Use agent_list to see all runs.`);
        }
        const criteria = run.acceptanceCriteria?.length
          ? `\nAcceptance criteria:\n${run.acceptanceCriteria.map((criterion, index) => `${index + 1}. ${criterion}`).join("\n")}`
          : "";
        const tracking = `\nTask: ${run.taskId ?? "untracked"}\nStep: ${run.currentStep ?? "not reported"}\nProgress: ${run.progress ?? 0}%`;
        const detail =
          run.status === "completed"
            ? `Result:\n${run.result ?? "(empty)"}`
            : run.status === "failed"
            ? `Error: ${run.error ?? "(unknown)"}`
            : `Status: ${run.status}`;

        return ok(
          `Agent ${agentId} — ${run.status}${tracking}${criteria}\n${detail}`,
          { summary: `Agent ${run.name}: ${run.status}` },
        );
      },
    },

    /* -------------------------------------------------------- agent_list */
    {
      definition: {
        name: "agent_list",
        title: "List Agents",
        description: "List all subagent runs in the current process, with their status.",
        inputSchema: {
          type: "object",
          properties: {},
        },
        icon: "bot",
        group: "agent",
        modes: ["cowork", "code"],
      },
      async handler(_input, ctx) {
        const runs = manager.listForSession(ctx.sessionId, ctx.mode);
        if (runs.length === 0) return ok("No subagent runs.", { summary: "No agents" });

        const lines = runs.map(
          (r) => `[${r.id}] ${r.status.toUpperCase()} — ${r.name} — task ${r.taskId ?? "untracked"} — ${r.progress ?? 0}%`,
        );
        return ok(lines.join("\n"), { summary: `${runs.length} agent run(s)` });
      },
    },
  ];
}

/* Singleton for production use. Runner is injected at app startup. */
let _defaultManager: SubagentManager | null = null;

export function getDefaultManager(runner?: AgentRunner): SubagentManager {
  if (!_defaultManager) {
    if (!runner) throw new Error("SubagentManager not initialised — provide a runner.");
    _defaultManager = new SubagentManager(runner);
  }
  return _defaultManager;
}

/* Re-exported empty list — caller must construct tools with a real manager. */
export const subagentTools: Tool[] = [];

/* --------------------------------------------------- parseSubagentFile ---- */

export interface SubagentFileMeta {
  name: string;
  description: string;
  systemPrompt: string;
  tools?: string[];
  model?: string;
}

/**
 * Parse a Claude-style agent markdown file.
 * Frontmatter: name, description, tools (comma-separated or inline array), model.
 * Body becomes systemPrompt.
 */
export function parseSubagentFile(text: string, _path: string): SubagentFileMeta {
  const { data, body } = parseFrontmatter(text);

  const name = typeof data["name"] === "string" ? data["name"].trim() : "";
  const description =
    typeof data["description"] === "string" ? data["description"].trim() : "";
  const model = typeof data["model"] === "string" ? data["model"].trim() : undefined;

  let tools: string[] | undefined;
  const rawTools = data["tools"];
  if (Array.isArray(rawTools)) {
    tools = rawTools.map(String);
  } else if (typeof rawTools === "string" && rawTools.trim()) {
    tools = rawTools
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return {
    name,
    description,
    systemPrompt: body.trim(),
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(model ? { model } : {}),
  };
}
