/**
 * Kozum Cowork — schedule tools.
 *
 * Five tools exposed only in "cowork" mode — scheduled tasks are the
 * feature that distinguishes Cowork from Code mode.
 *
 *   schedule_create    — create a new scheduled task
 *   schedule_list      — list tasks with next-run times
 *   schedule_update    — patch an existing task
 *   schedule_delete    — remove a task (dangerous)
 *   schedule_run_now   — fire immediately without altering the cadence
 */

import type { Tool } from "./registry.ts";
import { ok, fail } from "./registry.ts";
import type { Scheduler } from "../schedule/scheduler.ts";
import { parseCron, describeCron, nextRun } from "../schedule/cron.ts";

/* ============================================================= helpers == */

function formatTs(ms: number | undefined): string {
  if (ms === undefined) return "—";
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

const CRON_EXAMPLES = [
  '"0 9 * * 1-5"  — weekdays at 09:00',
  '"*/30 * * * *" — every 30 minutes',
  '"0 0 1 * *"    — first of every month at midnight',
];

/* ============================================================= factory == */

export function makeScheduleTools(scheduler: Scheduler): Tool[] {
  return [

    /* -------------------------------------------------------- schedule_create */
    {
      definition: {
        name: "schedule_create",
        title: "Create Scheduled Task",
        description:
          "Create a new scheduled task. The task fires a fresh agent session " +
          "on the given cron schedule, evaluated in the specified timezone. " +
          "Tasks only run while the machine is awake (local runner, no cloud). " +
          "Use @daily, @weekly, @hourly macros or a standard 5-field cron expression.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Short human-readable name for this task.",
            },
            prompt: {
              type: "string",
              description: "The prompt sent to a fresh agent session when the task fires.",
            },
            cron: {
              type: "string",
              description:
                '5-field cron expression or macro (@daily, @hourly, @weekly, @monthly, @yearly). ' +
                'Fields: minute hour day-of-month month day-of-week. ' +
                'Examples: "0 9 * * 1-5" (weekdays at 09:00), "*/30 * * * *" (every 30 min).',
            },
            timezone: {
              type: "string",
              description:
                'IANA timezone name (e.g. "America/New_York", "Europe/London", "Asia/Tokyo"). ' +
                'Defaults to UTC.',
              default: "UTC",
            },
            mode: {
              type: "string",
              description: 'Agent mode to run the task in. Defaults to "cowork".',
              enum: ["cowork", "code"],
              default: "cowork",
            },
            workingFolder: {
              type: "string",
              description: "Absolute path to scope the agent session to (optional).",
            },
          },
          required: ["name", "prompt", "cron"],
        },
        icon: "calendar-plus",
        group: "task",
        modes: ["cowork"],
      },

      handler: async (input, _ctx) => {
        const name    = input["name"]          as string;
        const prompt  = input["prompt"]        as string;
        const cron    = input["cron"]          as string;
        const tz      = (input["timezone"]     as string | undefined) ?? "UTC";
        const mode    = (input["mode"]         as "cowork" | "code" | undefined) ?? "cowork";
        const folder  = (input["workingFolder"] as string | undefined) ?? null;

        // Validate cron expression before touching the scheduler.
        let spec;
        try {
          spec = parseCron(cron);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return fail(
            `Invalid cron expression: ${msg}\n\n` +
            `Correct examples:\n${CRON_EXAMPLES.join("\n")}`,
          );
        }

        // Validate timezone
        try {
          nextRun(spec, new Date(), tz);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return fail(`Cron/timezone problem: ${msg}\n\nExamples:\n${CRON_EXAMPLES.join("\n")}`);
        }

        let task;
        try {
          task = scheduler.add({
            name,
            prompt,
            cron,
            timezone: tz,
            mode,
            workingFolder: folder,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return fail(msg);
        }

        const description = describeCron(spec);
        const content =
          `Created task "${name}" (${task.id})\n` +
          `Schedule: ${description} (${cron})\n` +
          `Timezone: ${tz}\n` +
          `Next run: ${formatTs(task.nextRunAt)}`;

        return ok(content, {
          summary: `Scheduled "${name}" — ${description}`,
        });
      },
    },

    /* -------------------------------------------------------- schedule_list */
    {
      definition: {
        name: "schedule_list",
        title: "List Scheduled Tasks",
        description:
          "List all scheduled tasks with their status, next-run time, and run history.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
        icon: "calendar",
        group: "task",
        modes: ["cowork"],
      },

      handler: async (_input, _ctx) => {
        const tasks = scheduler.list();

        if (tasks.length === 0) {
          return ok(
            "No scheduled tasks. Use schedule_create to add one.",
            { summary: "0 tasks" },
          );
        }

        const lines = tasks.map((t) => {
          const status = t.enabled ? "enabled" : "disabled";
          const last   = t.lastStatus ? ` | last: ${t.lastStatus}` : "";
          let desc = "";
          try {
            desc = describeCron(parseCron(t.cron));
          } catch {
            desc = t.cron;
          }
          return (
            `[${t.id}] ${t.name}\n` +
            `  Status:   ${status}\n` +
            `  Schedule: ${desc} (${t.cron}) — ${t.timezone}\n` +
            `  Next run: ${formatTs(t.nextRunAt)}\n` +
            `  Runs:     ${t.runCount}${last}\n` +
            (t.lastError ? `  Error:    ${t.lastError}\n` : "")
          );
        });

        return ok(
          `${tasks.length} scheduled task(s):\n\n${lines.join("\n")}`,
          { summary: `${tasks.length} task(s)` },
        );
      },
    },

    /* -------------------------------------------------------- schedule_update */
    {
      definition: {
        name: "schedule_update",
        title: "Update Scheduled Task",
        description:
          "Update fields on an existing scheduled task. " +
          "All fields except id are optional — only supplied fields are changed.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Task ID to update." },
            name:         { type: "string",  description: "New name." },
            prompt:       { type: "string",  description: "New prompt." },
            cron:         { type: "string",  description: "New cron expression." },
            timezone:     { type: "string",  description: "New IANA timezone." },
            enabled:      { type: "boolean", description: "Enable or disable the task." },
            workingFolder: { type: "string", description: "New working folder path." },
          },
          required: ["id"],
        },
        icon: "calendar-cog",
        group: "task",
        modes: ["cowork"],
      },

      handler: async (input, _ctx) => {
        const id = input["id"] as string;

        // If cron is being updated, validate it first.
        if (input["cron"] !== undefined) {
          try {
            parseCron(input["cron"] as string);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return fail(
              `Invalid cron expression: ${msg}\n\nExamples:\n${CRON_EXAMPLES.join("\n")}`,
            );
          }
        }

        const updated = scheduler.update(id, {
          name:          input["name"]          as string  | undefined,
          prompt:        input["prompt"]        as string  | undefined,
          cron:          input["cron"]          as string  | undefined,
          timezone:      input["timezone"]      as string  | undefined,
          enabled:       input["enabled"]       as boolean | undefined,
          workingFolder: input["workingFolder"] as string  | undefined,
        });

        if (!updated) return fail(`Task not found: ${id}`);

        let desc = "";
        try {
          desc = describeCron(parseCron(updated.cron));
        } catch {
          desc = updated.cron;
        }

        return ok(
          `Updated task "${updated.name}" (${updated.id})\n` +
          `Next run: ${formatTs(updated.nextRunAt)}\n` +
          `Schedule: ${desc}`,
          { summary: `Updated "${updated.name}"` },
        );
      },
    },

    /* -------------------------------------------------------- schedule_delete */
    {
      definition: {
        name: "schedule_delete",
        title: "Delete Scheduled Task",
        description: "Permanently remove a scheduled task. This cannot be undone.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Task ID to delete." },
          },
          required: ["id"],
        },
        icon: "calendar-x",
        group: "task",
        dangerous: true,
        modes: ["cowork"],
      },

      handler: async (input, _ctx) => {
        const id = input["id"] as string;
        const removed = scheduler.remove(id);
        if (!removed) return fail(`Task not found: ${id}`);
        return ok(`Deleted task ${id}`, { summary: `Deleted task ${id}` });
      },
    },

    /* ------------------------------------------------------ schedule_run_now */
    {
      definition: {
        name: "schedule_run_now",
        title: "Run Task Now",
        description:
          "Fire a scheduled task immediately, outside its normal cadence. " +
          "The task's nextRunAt is not changed — it continues on its normal schedule.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Task ID to run immediately." },
          },
          required: ["id"],
        },
        icon: "play",
        group: "task",
        modes: ["cowork"],
      },

      handler: async (input, _ctx) => {
        const id = input["id"] as string;
        const taskBefore = scheduler.get(id);
        if (!taskBefore) return fail(`Task not found: ${id}`);

        try {
          await scheduler.runNow(id);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return fail(`Failed to run task: ${msg}`);
        }

        const taskAfter = scheduler.get(id);
        const status = taskAfter?.lastStatus ?? "unknown";

        return ok(
          `Ran task "${taskBefore.name}" (${id})\n` +
          `Status:   ${status}\n` +
          `Next run: ${formatTs(taskAfter?.nextRunAt)}`,
          { summary: `Ran "${taskBefore.name}" — ${status}` },
        );
      },
    },

  ];
}
