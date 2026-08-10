/**
 * Task-tracking tools — create, get, update, list, stop tasks per session.
 *
 * TaskStore is keyed by sessionId so tasks are isolated between sessions.
 * The store emits nothing itself; the current task list is returned in content
 * on every mutating call so the model always sees the current state.
 */

import type { AgentTask } from "../../shared/types.ts";
import type { Tool } from "./registry.ts";
import { ok, fail } from "./registry.ts";

/* -------------------------------------------------------------- id gen ---- */

let seq = 0;
function newTaskId(): string {
  seq += 1;
  return `task_${Date.now().toString(36)}_${seq.toString(36)}`;
}

/* ------------------------------------------------------------ TaskStore ---- */

/**
 * Listener invoked after every mutating operation with the full, current task
 * list for the affected session. Wired by index.ts to emit a `task_update`
 * event so the renderer shows live task progress (P1-2). Optional so the shared
 * `defaultTaskStore` works unchanged in contexts without an emitter.
 */
export type TaskListener = (sessionId: string, tasks: AgentTask[]) => void;

export class TaskStore {
  private sessions = new Map<string, Map<string, AgentTask>>();
  private readonly listener?: TaskListener;

  constructor(listener?: TaskListener) {
    this.listener = listener;
  }

  private emit(sessionId: string): void {
    this.listener?.(sessionId, this.list(sessionId));
  }

  private getSession(sessionId: string): Map<string, AgentTask> {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = new Map();
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  create(
    sessionId: string,
    subject: string,
    description: string,
    status: AgentTask["status"] = "pending",
  ): AgentTask {
    const session = this.getSession(sessionId);
    const now = Date.now();
    const task: AgentTask = {
      id: newTaskId(),
      subject,
      description,
      status,
      createdAt: now,
      updatedAt: now,
    };
    session.set(task.id, task);
    this.emit(sessionId);
    return task;
  }

  get(sessionId: string, taskId: string): AgentTask | undefined {
    return this.getSession(sessionId).get(taskId);
  }

  list(sessionId: string): AgentTask[] {
    return [...this.getSession(sessionId).values()];
  }

  update(
    sessionId: string,
    taskId: string,
    fields: Partial<Pick<AgentTask, "status" | "subject" | "description">>,
  ): AgentTask | undefined {
    const session = this.getSession(sessionId);
    const task = session.get(taskId);
    if (!task) return undefined;

    const updated: AgentTask = {
      ...task,
      ...fields,
      updatedAt: Date.now(),
    };
    session.set(taskId, updated);
    this.emit(sessionId);
    return updated;
  }

  stop(sessionId: string, taskId: string): AgentTask | undefined {
    return this.update(sessionId, taskId, { status: "stopped" });
  }
}

/* ----------------------------------------------------------- task tools --- */

const VALID_STATUSES: AgentTask["status"][] = [
  "pending",
  "in_progress",
  "completed",
  "failed",
  "stopped",
];

function isValidStatus(s: unknown): s is AgentTask["status"] {
  return typeof s === "string" && (VALID_STATUSES as string[]).includes(s);
}

function tasksToContent(tasks: AgentTask[]): string {
  if (tasks.length === 0) return "No tasks.";
  return tasks
    .map(
      (t) =>
        `[${t.id}] ${t.status.toUpperCase()} — ${t.subject}\n  ${t.description}`,
    )
    .join("\n");
}

export function makeTaskTools(store: TaskStore): Tool[] {
  return [
    /* -------------------------------------------------------- task_create */
    {
      definition: {
        name: "task_create",
        title: "Create Task",
        description:
          "Create a new task for the current session. Use this to track distinct " +
          "work items or sub-goals that need to be completed. Returns the task id " +
          "and the full updated task list.",
        inputSchema: {
          type: "object",
          properties: {
            subject: {
              type: "string",
              description: "Short title / headline for the task (3–10 words).",
            },
            description: {
              type: "string",
              description: "Detailed description of what the task entails.",
            },
            status: {
              type: "string",
              description:
                "Initial status. One of: pending, in_progress, completed, failed, stopped. Default: pending.",
              enum: VALID_STATUSES,
              default: "pending",
            },
          },
          required: ["subject", "description"],
        },
        icon: "list-todo",
        group: "task",
        modes: ["cowork", "code"],
      },
      async handler(input, ctx) {
        const subject = String(input["subject"] ?? "").trim();
        const description = String(input["description"] ?? "").trim();
        const rawStatus = input["status"] ?? "pending";
        const status = isValidStatus(rawStatus) ? rawStatus : "pending";

        const task = store.create(ctx.sessionId, subject, description, status);
        const all = store.list(ctx.sessionId);

        return ok(
          `Created task ${task.id}.\n\nCurrent tasks:\n${tasksToContent(all)}`,
          { summary: `Task created: ${subject}` },
        );
      },
    },

    /* ---------------------------------------------------------- task_get */
    {
      definition: {
        name: "task_get",
        title: "Get Task",
        description: "Retrieve a single task by its id.",
        inputSchema: {
          type: "object",
          properties: {
            taskId: { type: "string", description: "The task id returned by task_create." },
          },
          required: ["taskId"],
        },
        icon: "list-todo",
        group: "task",
        modes: ["cowork", "code"],
      },
      async handler(input, ctx) {
        const taskId = String(input["taskId"] ?? "").trim();
        const task = store.get(ctx.sessionId, taskId);
        if (!task) {
          return fail(
            `Task "${taskId}" not found. Use task_list to see all task ids for this session.`,
          );
        }
        return ok(
          JSON.stringify(task, null, 2),
          { summary: `Task ${taskId}: ${task.subject}` },
        );
      },
    },

    /* --------------------------------------------------------- task_list */
    {
      definition: {
        name: "task_list",
        title: "List Tasks",
        description: "List all tasks for the current session, including their status.",
        inputSchema: {
          type: "object",
          properties: {},
        },
        icon: "list-todo",
        group: "task",
        modes: ["cowork", "code"],
      },
      async handler(_input, ctx) {
        const tasks = store.list(ctx.sessionId);
        return ok(tasksToContent(tasks), { summary: `${tasks.length} task(s)` });
      },
    },

    /* ------------------------------------------------------- task_update */
    {
      definition: {
        name: "task_update",
        title: "Update Task",
        description:
          "Update a task's status, subject, or description. " +
          "Provide only the fields you want to change.",
        inputSchema: {
          type: "object",
          properties: {
            taskId: { type: "string", description: "The task id." },
            status: {
              type: "string",
              description: "New status. One of: pending, in_progress, completed, failed, stopped.",
              enum: VALID_STATUSES,
            },
            subject: { type: "string", description: "New subject/title." },
            description: { type: "string", description: "New description." },
          },
          required: ["taskId"],
        },
        icon: "list-todo",
        group: "task",
        modes: ["cowork", "code"],
      },
      async handler(input, ctx) {
        const taskId = String(input["taskId"] ?? "").trim();

        const fields: Partial<Pick<AgentTask, "status" | "subject" | "description">> = {};
        if (input["status"] !== undefined && isValidStatus(input["status"])) {
          fields.status = input["status"] as AgentTask["status"];
        }
        if (typeof input["subject"] === "string" && input["subject"].trim()) {
          fields.subject = input["subject"].trim();
        }
        if (typeof input["description"] === "string") {
          fields.description = input["description"];
        }

        const task = store.update(ctx.sessionId, taskId, fields);
        if (!task) {
          return fail(
            `Task "${taskId}" not found. Use task_list to see all task ids for this session.`,
          );
        }

        const all = store.list(ctx.sessionId);
        return ok(
          `Updated task ${taskId}.\n\nCurrent tasks:\n${tasksToContent(all)}`,
          { summary: `Task updated: ${task.subject}` },
        );
      },
    },

    /* --------------------------------------------------------- task_stop */
    {
      definition: {
        name: "task_stop",
        title: "Stop Task",
        description: "Mark a task as stopped. Use when work on a task is abandoned or cancelled.",
        inputSchema: {
          type: "object",
          properties: {
            taskId: { type: "string", description: "The task id." },
          },
          required: ["taskId"],
        },
        icon: "list-todo",
        group: "task",
        modes: ["cowork", "code"],
      },
      async handler(input, ctx) {
        const taskId = String(input["taskId"] ?? "").trim();
        const task = store.stop(ctx.sessionId, taskId);
        if (!task) {
          return fail(
            `Task "${taskId}" not found. Use task_list to see all task ids for this session.`,
          );
        }

        const all = store.list(ctx.sessionId);
        return ok(
          `Stopped task ${taskId}.\n\nCurrent tasks:\n${tasksToContent(all)}`,
          { summary: `Task stopped: ${task.subject}` },
        );
      },
    },
  ];
}

/* Singleton store, shared across the process lifetime (one session per call). */
export const defaultTaskStore = new TaskStore();
export const taskTools: Tool[] = makeTaskTools(defaultTaskStore);
