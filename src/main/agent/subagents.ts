/**
 * Subagent tools — launch background agents and track their runs.
 *
 * SubagentManager wraps a user-supplied `runner` callback so the implementation
 * is fully testable without a real LLM provider. Runs are tracked in memory per
 * manager instance; a concurrency cap (default 4) queues beyond that.
 */

import type { SubagentRun } from "../../shared/types.ts";
import type { Tool } from "../tools/registry.ts";
import { ok, fail } from "../tools/registry.ts";
import { parseFrontmatter } from "./frontmatter.ts";

/* -------------------------------------------------------------- runner ---- */

export interface RunnerSpec {
  id: string;
  name: string;
  systemPrompt: string;
  prompt: string;
  model?: string;
  tools?: string[];
}

export type AgentRunner = (spec: RunnerSpec) => Promise<{ text: string; usage?: unknown }>;

/* ----------------------------------------------------------- id gen ---- */

let seq = 0;
function newRunId(): string {
  seq += 1;
  return `agent_${Date.now().toString(36)}_${seq.toString(36)}`;
}

/* ---------------------------------------------------- SubagentManager ---- */

export class SubagentManager {
  private runs = new Map<string, SubagentRun>();
  private active = 0;
  private readonly concurrencyLimit: number;
  private queue: Array<() => void> = [];
  private runner: AgentRunner;

  constructor(runner: AgentRunner, concurrencyLimit = 4) {
    this.runner = runner;
    this.concurrencyLimit = concurrencyLimit;
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
  ): string {
    const id = newRunId();
    const run: SubagentRun = {
      id,
      parentSessionId,
      name,
      description,
      status: "running",
      startedAt: Date.now(),
    };
    this.runs.set(id, run);

    this.schedule(() => this.executeRun(id, systemPrompt, prompt, model, tools));

    return id;
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
  ): void {
    const run = this.runs.get(id);
    if (!run) return;

    const spec: RunnerSpec = {
      id,
      name: run.name,
      systemPrompt,
      prompt,
      ...(model !== undefined ? { model } : {}),
      ...(tools !== undefined ? { tools } : {}),
    };

    this.runner(spec)
      .then((result) => {
        this.runs.set(id, {
          ...run,
          status: "completed",
          endedAt: Date.now(),
          result: result.text,
        });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.runs.set(id, {
          ...run,
          status: "failed",
          endedAt: Date.now(),
          error: message,
        });
      })
      .finally(() => {
        this.onFinish();
      });
  }

  getStatus(id: string): SubagentRun | undefined {
    return this.runs.get(id);
  }

  listAll(): SubagentRun[] {
    return [...this.runs.values()];
  }

  cancel(id: string): boolean {
    const run = this.runs.get(id);
    if (!run || run.status !== "running") return false;
    this.runs.set(id, { ...run, status: "cancelled", endedAt: Date.now() });
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
                "Full, self-contained task prompt. Include all context the subagent " +
                "needs; it has no access to the current conversation.",
            },
            model: {
              type: "string",
              description: "Optional model id override for this run.",
            },
            isolation: {
              type: "boolean",
              description: "Placeholder for future isolation flag. Currently unused.",
            },
          },
          required: ["description", "prompt"],
        },
        icon: "bot",
        group: "agent",
        modes: ["cowork", "code"],
      },
      async handler(input, ctx) {
        const description = String(input["description"] ?? "").trim();
        const prompt = String(input["prompt"] ?? "").trim();
        const model = input["model"] !== undefined ? String(input["model"]) : undefined;

        const id = manager.launch(
          ctx.sessionId,
          description,
          description,
          "",
          prompt,
          model,
        );

        return ok(
          `Subagent launched. id: ${id}\nUse agent_status to poll.`,
          { summary: `Subagent launched: ${description}` },
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
      async handler(input, _ctx) {
        const agentId = String(input["agentId"] ?? "").trim();
        const run = manager.getStatus(agentId);
        if (!run) {
          return fail(`No subagent run found with id "${agentId}". Use agent_list to see all runs.`);
        }
        const detail =
          run.status === "completed"
            ? `Result:\n${run.result ?? "(empty)"}`
            : run.status === "failed"
            ? `Error: ${run.error ?? "(unknown)"}`
            : `Status: ${run.status}`;

        return ok(
          `Agent ${agentId} — ${run.status}\n${detail}`,
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
      async handler(_input, _ctx) {
        const runs = manager.listAll();
        if (runs.length === 0) return ok("No subagent runs.", { summary: "No agents" });

        const lines = runs.map(
          (r) => `[${r.id}] ${r.status.toUpperCase()} — ${r.name}`,
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
