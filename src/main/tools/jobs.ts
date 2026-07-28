/**
 * Background job registry and associated tools.
 *
 * shell_exec_bg   — start a command and return a jobId immediately
 * shell_job_status — status only (running/completed/failed/killed)
 * shell_job_result — full stdout/stderr once done
 * shell_job_list   — list all or only running jobs
 * shell_job_kill   — kill by jobId
 * shell_job_clear  — remove a resolved job; refuse if still running
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Tool } from "./registry.ts";
import { ok, fail, describeError } from "./registry.ts";

/* ---------------------------------------------------------------- types --- */

type JobStatus = "running" | "completed" | "failed" | "killed";

type ShellName = "cmd" | "powershell" | "bash";

interface Job {
  id: string;
  label: string;
  command: string;
  status: JobStatus;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /** Child process while running */
  child?: ReturnType<typeof spawn>;
  /** Resolvers waiting for completion */
  waiters: Array<() => void>;
}

/* -------------------------------------------------------------- registry -- */

const MAX_BYTES = 1 * 1024 * 1024; // 1 MB

function defaultShell(): ShellName {
  return process.platform === "win32" ? "cmd" : "bash";
}

function shellArgs(shell: ShellName, command: string): { file: string; args: string[] } {
  switch (shell) {
    case "cmd":
      return { file: "cmd.exe", args: ["/D", "/C", command] };
    case "powershell":
      return { file: "powershell.exe", args: ["-NoProfile", "-Command", command] };
    case "bash":
    default:
      return { file: "/bin/bash", args: ["-c", command] };
  }
}

function killTree(child: ReturnType<typeof spawn>) {
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
    } else if (child.pid !== undefined) {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    child.kill("SIGKILL");
  }
}

export class JobRegistry {
  private jobs = new Map<string, Job>();

  start(
    command: string,
    shell: ShellName,
    cwd: string | undefined,
    env: Record<string, string> | undefined,
    label: string,
  ): string {
    const id = randomUUID();

    const { file, args } = shellArgs(shell, command);
    const mergedEnv = env ? { ...process.env, ...env } : undefined;

    const child = spawn(file, args, {
      cwd,
      env: mergedEnv,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const job: Job = {
      id,
      label: label || command.slice(0, 80),
      command,
      status: "running",
      startedAt: Date.now(),
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      child,
      waiters: [],
    };

    this.jobs.set(id, job);

    let stdoutBytes = 0;
    let stderrBytes = 0;

    child.stdout.on("data", (chunk: Buffer) => {
      const remaining = MAX_BYTES - stdoutBytes;
      if (remaining <= 0) {
        job.stdoutTruncated = true;
        return;
      }
      const slice = remaining < chunk.length ? chunk.subarray(0, remaining) : chunk;
      job.stdout += slice.toString("utf8");
      stdoutBytes += slice.length;
      if (stdoutBytes >= MAX_BYTES) job.stdoutTruncated = true;
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = MAX_BYTES - stderrBytes;
      if (remaining <= 0) {
        job.stderrTruncated = true;
        return;
      }
      const slice = remaining < chunk.length ? chunk.subarray(0, remaining) : chunk;
      job.stderr += slice.toString("utf8");
      stderrBytes += slice.length;
      if (stderrBytes >= MAX_BYTES) job.stderrTruncated = true;
    });

    const settle = (status: JobStatus, exitCode: number | null | undefined) => {
      if (job.status !== "running") return;
      job.status = status;
      job.endedAt = Date.now();
      job.exitCode = exitCode ?? null;
      delete job.child;
      // Notify all waiters
      for (const waiter of job.waiters) waiter();
      job.waiters = [];
    };

    child.on("error", (err) => {
      job.stderr += `\nSpawn error: ${err.message}`;
      settle("failed", null);
    });

    child.on("close", (code) => {
      const status: JobStatus = code === 0 ? "completed" : "failed";
      settle(status, code);
    });

    return id;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(includeResolved: boolean): Job[] {
    const all = [...this.jobs.values()];
    if (includeResolved) return all;
    return all.filter((j) => j.status === "running");
  }

  async waitFor(id: string, timeoutSeconds: number): Promise<Job | undefined> {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.status !== "running") return job;
    if (timeoutSeconds <= 0) return job;

    return new Promise<Job>((resolve) => {
      let timer: NodeJS.Timeout | null = null;

      const done = () => {
        if (timer) clearTimeout(timer);
        resolve(job);
      };

      job.waiters.push(done);

      timer = setTimeout(() => {
        const idx = job.waiters.indexOf(done);
        if (idx !== -1) job.waiters.splice(idx, 1);
        resolve(job);
      }, timeoutSeconds * 1000);
    });
  }

  kill(id: string, force: boolean): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status !== "running" || !job.child) return false;

    if (force || process.platform !== "win32") {
      killTree(job.child);
    } else {
      job.child.kill("SIGTERM");
    }

    job.status = "killed";
    job.endedAt = Date.now();
    job.exitCode = null;
    delete job.child;
    for (const waiter of job.waiters) waiter();
    job.waiters = [];
    return true;
  }

  clear(id: string): "ok" | "running" | "not_found" {
    const job = this.jobs.get(id);
    if (!job) return "not_found";
    if (job.status === "running") return "running";
    this.jobs.delete(id);
    return "ok";
  }
}

/* ------------------------------------------------ shared registry instance */

// Module-level singleton so it survives across tool calls in the same process
export const jobRegistry = new JobRegistry();

/* --------------------------------------------------------------- helpers -- */

function jobSummaryText(job: Job): string {
  const elapsed =
    job.endedAt !== undefined
      ? `${((job.endedAt - job.startedAt) / 1000).toFixed(1)}s`
      : `${((Date.now() - job.startedAt) / 1000).toFixed(1)}s (running)`;
  return (
    `Job ${job.id}\n` +
    `  label:   ${job.label}\n` +
    `  command: ${job.command}\n` +
    `  status:  ${job.status}\n` +
    `  started: ${new Date(job.startedAt).toISOString()}\n` +
    (job.endedAt !== undefined ? `  ended:   ${new Date(job.endedAt).toISOString()}\n` : "") +
    `  elapsed: ${elapsed}\n` +
    (job.exitCode !== undefined ? `  exit:    ${job.exitCode}\n` : "")
  );
}

/* --------------------------------------------------------------- tools ---- */

export const jobTools: Tool[] = [
  /* ---- shell_exec_bg ------------------------------------------ */
  {
    definition: {
      name: "shell_exec_bg",
      title: "Shell Execute Background",
      description:
        "Start a shell command in the background and return a jobId immediately, without waiting. " +
        "Use this for long-running commands like servers or builds that you want to monitor later. " +
        "Use shell_job_status or shell_job_result to check progress.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to run." },
          cwd: { type: "string", description: "Working directory." },
          shell: {
            type: "string",
            enum: ["cmd", "powershell", "bash"],
            description: "Shell to use. Defaults to platform default.",
          },
          env: { type: "object", description: "Extra environment variables." },
          label: { type: "string", description: "Human-readable label for this job." },
        },
        required: ["command"],
      },
      icon: "play",
      group: "shell",
      modes: ["cowork", "code"],
    },

    handler: async (input, ctx) => {
      const command = input["command"] as string;
      const cwdRaw = input["cwd"] as string | undefined;
      const shellName = (input["shell"] as ShellName | undefined) ?? defaultShell();
      const env = input["env"] as Record<string, string> | undefined;
      const label = (input["label"] as string | undefined) ?? "";

      const cwd = cwdRaw ?? ctx.workingFolder ?? undefined;

      try {
        const jobId = jobRegistry.start(command, shellName, cwd, env, label);
        return ok(`Started background job ${jobId}\ncommand: ${command}`, {
          summary: `Started background job: ${label || command.slice(0, 60)}`,
        });
      } catch (e) {
        return fail(describeError(e));
      }
    },
  },

  /* ---- shell_job_status --------------------------------------- */
  {
    definition: {
      name: "shell_job_status",
      title: "Job Status",
      description:
        "Check the status of a background job (running, completed, failed, killed). " +
        "Returns status only — no output. Use shell_job_result to get output. " +
        "Pass wait > 0 to block up to N seconds for the job to finish.",
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "The job ID returned by shell_exec_bg." },
          wait: { type: "number", description: "Seconds to wait for completion (0 = no wait).", default: 0 },
        },
        required: ["jobId"],
      },
      icon: "activity",
      group: "shell",
      modes: ["cowork", "code"],
    },

    handler: async (input, _ctx) => {
      const jobId = input["jobId"] as string;
      const wait = (input["wait"] as number | undefined) ?? 0;

      let job = jobRegistry.get(jobId);
      if (!job) return fail(`Job not found: ${jobId}`);

      if (wait > 0 && job.status === "running") {
        job = (await jobRegistry.waitFor(jobId, wait)) ?? job;
      }

      return ok(jobSummaryText(job), { summary: `Job ${jobId}: ${job.status}` });
    },
  },

  /* ---- shell_job_result -------------------------------------- */
  {
    definition: {
      name: "shell_job_result",
      title: "Job Result",
      description:
        "Get the full stdout and stderr of a background job. " +
        "Pass wait > 0 to block up to N seconds for the job to finish. " +
        "Output is bounded at maxBytes (default 1 MB).",
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "The job ID." },
          wait: { type: "number", description: "Seconds to wait for completion (0 = no wait).", default: 0 },
          maxBytes: { type: "number", description: "Max bytes of output to return (default 1048576).", default: 1048576 },
        },
        required: ["jobId"],
      },
      icon: "file-text",
      group: "shell",
      modes: ["cowork", "code"],
    },

    handler: async (input, _ctx) => {
      const jobId = input["jobId"] as string;
      const wait = (input["wait"] as number | undefined) ?? 0;
      const maxBytes = (input["maxBytes"] as number | undefined) ?? MAX_BYTES;

      let job = jobRegistry.get(jobId);
      if (!job) return fail(`Job not found: ${jobId}`);

      if (wait > 0 && job.status === "running") {
        job = (await jobRegistry.waitFor(jobId, wait)) ?? job;
      }

      let stdout = job.stdout;
      let stderr = job.stderr;
      const notices: string[] = [];

      if (Buffer.byteLength(stdout) > maxBytes) {
        stdout = Buffer.from(stdout).subarray(0, maxBytes).toString("utf8");
        notices.push("[stdout truncated]");
      }
      if (Buffer.byteLength(stderr) > maxBytes) {
        stderr = Buffer.from(stderr).subarray(0, maxBytes).toString("utf8");
        notices.push("[stderr truncated]");
      }
      if (job.stdoutTruncated) notices.push("[stdout was truncated at collection]");
      if (job.stderrTruncated) notices.push("[stderr was truncated at collection]");

      const content = [
        jobSummaryText(job),
        notices.join("\n"),
        stdout ? `stdout:\n${stdout}` : "(no stdout)",
        stderr ? `stderr:\n${stderr}` : "(no stderr)",
      ]
        .filter(Boolean)
        .join("\n");

      return ok(content, {
        summary: `Job ${jobId} result (${job.status})`,
        terminal: { command: job.command, stdout, stderr, exitCode: job.exitCode ?? null },
      });
    },
  },

  /* ---- shell_job_list ---------------------------------------- */
  {
    definition: {
      name: "shell_job_list",
      title: "Job List",
      description:
        "List background jobs. By default includes resolved jobs. " +
        "Pass includeResolved: false to see only running jobs.",
      inputSchema: {
        type: "object",
        properties: {
          includeResolved: {
            type: "boolean",
            description: "Include completed/failed/killed jobs (default true).",
            default: true,
          },
        },
        required: [],
      },
      icon: "list",
      group: "shell",
      modes: ["cowork", "code"],
    },

    handler: async (input, _ctx) => {
      const includeResolved = (input["includeResolved"] as boolean | undefined) ?? true;
      const jobs = jobRegistry.list(includeResolved);

      if (jobs.length === 0) {
        return ok("No jobs.", { summary: "0 jobs" });
      }

      const lines = jobs.map(
        (j) =>
          `${j.id} | ${j.status.padEnd(9)} | ${j.label || j.command.slice(0, 60)}`,
      );

      return ok(
        `${jobs.length} job(s):\n${lines.join("\n")}`,
        { summary: `${jobs.length} job(s)` },
      );
    },
  },

  /* ---- shell_job_kill ---------------------------------------- */
  {
    definition: {
      name: "shell_job_kill",
      title: "Kill Job",
      description: "Kill a running background job. Use force: true to send SIGKILL / taskkill /F.",
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "The job ID to kill." },
          force: { type: "boolean", description: "Force-kill (SIGKILL / taskkill /F).", default: false },
        },
        required: ["jobId"],
      },
      icon: "square",
      group: "shell",
      modes: ["cowork", "code"],
    },

    handler: async (input, _ctx) => {
      const jobId = input["jobId"] as string;
      const force = (input["force"] as boolean | undefined) ?? false;

      const job = jobRegistry.get(jobId);
      if (!job) return fail(`Job not found: ${jobId}`);
      if (job.status !== "running") {
        return fail(`Job ${jobId} is not running (status: ${job.status})`);
      }

      const killed = jobRegistry.kill(jobId, force);
      if (!killed) return fail(`Failed to kill job ${jobId}`);

      return ok(`Killed job ${jobId}`, { summary: `Killed job ${jobId}` });
    },
  },

  /* ---- shell_job_clear --------------------------------------- */
  {
    definition: {
      name: "shell_job_clear",
      title: "Clear Job",
      description:
        "Remove a finished job from the registry. " +
        "Refuses to clear a running job — kill it first with shell_job_kill.",
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "The job ID to clear." },
        },
        required: ["jobId"],
      },
      icon: "trash-2",
      group: "shell",
      modes: ["cowork", "code"],
    },

    handler: async (input, _ctx) => {
      const jobId = input["jobId"] as string;

      const result = jobRegistry.clear(jobId);
      switch (result) {
        case "ok":
          return ok(`Cleared job ${jobId}`, { summary: `Cleared job ${jobId}` });
        case "running":
          return fail(`Job ${jobId} is still running. Kill it first with shell_job_kill.`);
        case "not_found":
          return fail(`Job not found: ${jobId}`);
      }
    },
  },
];
