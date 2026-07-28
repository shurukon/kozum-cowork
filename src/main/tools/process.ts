/**
 * process_list — list running processes (cross-platform normalised)
 * process_kill — kill a process by PID (refuses PID 0, 1, and our own PID)
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Tool } from "./registry.ts";
import { ok, fail } from "./registry.ts";

const execFileP = promisify(execFile);

/* --------------------------------------------------------------- types ---- */

interface ProcessEntry {
  pid: number;
  name: string;
  /** Resident set size in KB */
  rssKb: number;
  /** Elapsed time string e.g. "01:23:45" */
  elapsed: string;
}

/* --------------------------------------------------------------- helpers -- */

async function listProcesses(): Promise<ProcessEntry[]> {
  if (process.platform === "win32") {
    // tasklist /FO CSV /NH — "Image Name","PID","Session Name","Session#","Mem Usage"
    const { stdout } = await execFileP("tasklist", ["/FO", "CSV", "/NH"]);
    const entries: ProcessEntry[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // CSV: "name","pid","session","session#","mem kb"
      const parts = trimmed.split('","').map((p) => p.replace(/^"|"$/g, ""));
      if (parts.length < 5) continue;
      const pid = parseInt(parts[1] ?? "0", 10);
      const name = parts[0] ?? "";
      // mem usage e.g. "12,345 K" — strip commas, "K", spaces
      const memStr = (parts[4] ?? "0").replace(/[^0-9]/g, "");
      const rssKb = parseInt(memStr, 10) || 0;
      entries.push({ pid, name, rssKb, elapsed: "" });
    }
    return entries;
  } else {
    // ps -eo pid,comm,rss,etime
    const { stdout } = await execFileP("ps", ["-eo", "pid,comm,rss,etime"]);
    const entries: ProcessEntry[] = [];
    for (const line of stdout.split(/\r?\n/).slice(1)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length < 4) continue;
      const pid = parseInt(parts[0] ?? "0", 10);
      const name = parts[1] ?? "";
      const rssKb = parseInt(parts[2] ?? "0", 10) || 0;
      const elapsed = parts[3] ?? "";
      entries.push({ pid, name, rssKb, elapsed });
    }
    return entries;
  }
}

/* --------------------------------------------------------------- tools ---- */

export const processTools: Tool[] = [
  /* ---- process_list ------------------------------------------ */
  {
    definition: {
      name: "process_list",
      title: "Process List",
      description:
        "List running processes. Optionally filter by name (substring match). " +
        "Returns PID, name, memory (KB), and elapsed time. " +
        "On Windows uses tasklist; on Linux uses ps.",
      inputSchema: {
        type: "object",
        properties: {
          filter: {
            type: "string",
            description: "Substring filter on process name (case-insensitive).",
          },
        },
        required: [],
      },
      icon: "cpu",
      group: "process",
      modes: ["cowork", "code"],
    },

    handler: async (input, _ctx) => {
      const filter = (input["filter"] as string | undefined) ?? "";

      let entries: ProcessEntry[];
      try {
        entries = await listProcesses();
      } catch (e) {
        return fail(`Failed to list processes: ${e instanceof Error ? e.message : String(e)}`);
      }

      if (filter) {
        const lc = filter.toLowerCase();
        entries = entries.filter((e) => e.name.toLowerCase().includes(lc));
      }

      if (entries.length === 0) {
        return ok(filter ? `No processes matching "${filter}".` : "No processes found.", {
          summary: "0 processes",
        });
      }

      const header = "PID       NAME                         RSS(KB)   ELAPSED";
      const rows = entries.map(
        (e) =>
          `${String(e.pid).padEnd(10)}${e.name.slice(0, 28).padEnd(29)}${String(e.rssKb).padEnd(10)}${e.elapsed}`,
      );

      const content = [header, ...rows].join("\n");
      return ok(content, { summary: `${entries.length} process(es)` });
    },
  },

  /* ---- process_kill ------------------------------------------ */
  {
    definition: {
      name: "process_kill",
      title: "Kill Process",
      description:
        "Kill a process by PID. " +
        "DANGEROUS: this terminates an OS process. " +
        "Refuses to kill PID 0, PID 1, or the agent's own PID. " +
        "Pass force: true for SIGKILL (Linux) or taskkill /F (Windows).",
      inputSchema: {
        type: "object",
        properties: {
          pid: { type: "integer", description: "Process ID to kill." },
          force: { type: "boolean", description: "Force kill (SIGKILL / taskkill /F).", default: false },
        },
        required: ["pid"],
      },
      icon: "skull",
      group: "process",
      dangerous: true,
      modes: ["cowork", "code"],
    },

    handler: async (input, _ctx) => {
      const pid = input["pid"] as number;
      const force = (input["force"] as boolean | undefined) ?? false;

      if (pid === 0 || pid === 1) {
        return fail(`Refusing to kill PID ${pid} — this is a protected system process.`);
      }
      if (pid === process.pid) {
        return fail(`Refusing to kill PID ${process.pid} — that is the agent's own process.`);
      }

      try {
        if (process.platform === "win32") {
          const args = force ? ["/F", "/PID", String(pid)] : ["/PID", String(pid)];
          await execFileP("taskkill", args);
        } else {
          const signal = force ? "SIGKILL" : "SIGTERM";
          process.kill(pid, signal);
        }
        return ok(`Sent ${force ? "SIGKILL" : "SIGTERM"} to PID ${pid}.`, {
          summary: `Killed PID ${pid}`,
        });
      } catch (e) {
        return fail(`Failed to kill PID ${pid}: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  },
];
