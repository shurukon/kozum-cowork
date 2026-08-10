/**
 * shell_exec — run a command to completion, capturing stdout+stderr+exit code.
 *
 * Timeout precedence:
 *   noTimeout > timeoutSeconds > timeout (ms legacy) > default 120 s
 *
 * On timeout the process tree is killed and partial output is returned.
 * Output is capped at 1 MB per stream.
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { Tool, ToolContext } from "./registry.ts";
import { ok, fail, describeError } from "./registry.ts";

/* ---------------------------------------------------------------- types --- */

type ShellName = "cmd" | "powershell" | "bash";

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

/* --------------------------------------------------------------- helpers --- */

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

async function spawnCommand(
  command: string,
  shell: ShellName,
  cwd: string | undefined,
  env: Record<string, string> | undefined,
  timeoutMs: number | null,
  ctx: ToolContext,
): Promise<SpawnResult> {
  const { file, args } = shellArgs(shell, command);

  const mergedEnv = env ? { ...process.env, ...env } : undefined;

  const child = spawn(file, args, {
    cwd,
    env: mergedEnv,
    // detached on non-Windows so we can kill the process group
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdoutBuf = "";
  let stderrBuf = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;

  // Use StringDecoder to handle multi-byte UTF-8 sequences that may be split
  // across chunk boundaries (slice.toString("utf8") on a partial sequence
  // produces U+FFFD replacement characters).
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");

  child.stdout.on("data", (chunk: Buffer) => {
    const remaining = MAX_BYTES - stdoutBytes;
    if (remaining <= 0) {
      stdoutTruncated = true;
      return;
    }
    const slice = remaining < chunk.length ? chunk.subarray(0, remaining) : chunk;
    stdoutBuf += stdoutDecoder.write(slice);
    stdoutBytes += slice.length;
    if (stdoutBytes >= MAX_BYTES) stdoutTruncated = true;
  });

  child.stderr.on("data", (chunk: Buffer) => {
    const remaining = MAX_BYTES - stderrBytes;
    if (remaining <= 0) {
      stderrTruncated = true;
      return;
    }
    const slice = remaining < chunk.length ? chunk.subarray(0, remaining) : chunk;
    stderrBuf += stderrDecoder.write(slice);
    stderrBytes += slice.length;
    if (stderrBytes >= MAX_BYTES) stderrTruncated = true;
  });

  // Progress reporting: emit every 5 seconds during long runs
  let progressInterval: NodeJS.Timeout | null = null;
  let elapsed = 0;
  progressInterval = setInterval(() => {
    elapsed += 5;
    ctx.onProgress(`Running… (${elapsed}s, stdout ${stdoutBytes} bytes)`);
  }, 5000);

  const killTree = () => {
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
      } else if (child.pid !== undefined) {
        process.kill(-child.pid, "SIGKILL");
      }
    } catch {
      child.kill("SIGKILL");
    }
  };

  return new Promise<SpawnResult>((resolve) => {
    let settled = false;
    let timedOut = false;

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      if (progressInterval) clearInterval(progressInterval);
      resolve({ stdout: stdoutBuf, stderr: stderrBuf, exitCode, timedOut, stdoutTruncated, stderrTruncated });
    };

    // Honour AbortSignal
    const onAbort = () => {
      if (!settled) {
        killTree();
        finish(null);
      }
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    // Set up timeout.  After killing the tree we give child processes a 2-second
    // grace window to flush their stdio pipes and emit "close".  If "close" has
    // not arrived within the grace window (e.g. a grandchild escaped the group
    // and is holding stdout open) we call finish() directly so the promise
    // always settles at roughly timeoutMs, not "never".
    let timer: NodeJS.Timeout | null = null;
    if (timeoutMs !== null) {
      timer = setTimeout(() => {
        if (!settled) {
          timedOut = true;
          killTree();
          // Grace period: give the child a chance to close pipes cleanly.
          setTimeout(() => {
            finish(null);
          }, 2000);
        }
      }, timeoutMs);
    }

    child.on("error", (err) => {
      if (progressInterval) clearInterval(progressInterval);
      if (timer) clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      if (!settled) {
        settled = true;
        resolve({ stdout: stdoutBuf, stderr: stderrBuf + `\nSpawn error: ${err.message}`, exitCode: null, timedOut: false, stdoutTruncated, stderrTruncated });
      }
    });

    child.on("close", (code) => {
      // Flush any remaining bytes held by the StringDecoders.
      stdoutBuf += stdoutDecoder.end();
      stderrBuf += stderrDecoder.end();
      if (timer) clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      finish(code);
    });
  });
}

/* --------------------------------------------------------------- handler -- */

export const shellTools: Tool[] = [
  {
    definition: {
      name: "shell_exec",
      title: "Shell Execute",
      description:
        "Run a shell command to completion. Returns stdout, stderr, and exit code. " +
        "Use this to run scripts, build tools, tests, or any command-line program. " +
        "Prefer short timeouts for interactive tools. Non-zero exit codes are reported " +
        "as failures in the result, not as tool crashes. " +
        "Output is capped at 1 MB per stream; long outputs will be noted as truncated.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to run." },
          cwd: { type: "string", description: "Working directory; defaults to session working folder." },
          timeout: { type: "number", description: "Timeout in milliseconds (legacy). Prefer timeoutSeconds." },
          timeoutSeconds: { type: "number", description: "Timeout in seconds; 0 or absent means default 120 s." },
          noTimeout: { type: "boolean", description: "When true, disables all timeouts.", default: false },
          shell: {
            type: "string",
            enum: ["cmd", "powershell", "bash"],
            description: 'Shell to use: "cmd", "powershell", or "bash". Defaults to platform default.',
          },
          env: { type: "object", description: "Extra environment variables to add/override." },
        },
        required: ["command"],
      },
      icon: "terminal",
      group: "shell",
      modes: ["cowork", "code"],
    },

    handler: async (input, ctx) => {
      const command = input["command"] as string;
      const cwdRaw = input["cwd"] as string | undefined;
      const timeoutMs = input["timeout"] as number | undefined;
      const timeoutSeconds = input["timeoutSeconds"] as number | undefined;
      const noTimeout = (input["noTimeout"] as boolean | undefined) ?? false;
      const shellName = (input["shell"] as ShellName | undefined) ?? defaultShell();
      const env = input["env"] as Record<string, string> | undefined;

      // Resolve cwd
      let cwd: string | undefined;
      if (cwdRaw) {
        cwd = cwdRaw;
      } else if (ctx.workingFolder) {
        cwd = ctx.workingFolder;
      }

      // Timeout precedence: noTimeout > timeoutSeconds > timeout > default
      let resolvedTimeoutMs: number | null;
      if (noTimeout) {
        resolvedTimeoutMs = null;
      } else if (timeoutSeconds !== undefined && timeoutSeconds !== null && timeoutSeconds > 0) {
        resolvedTimeoutMs = timeoutSeconds * 1000;
      } else if (timeoutMs !== undefined && timeoutMs !== null && timeoutMs > 0) {
        resolvedTimeoutMs = timeoutMs;
      } else {
        resolvedTimeoutMs = 120_000; // 120 seconds default
      }

      let result: SpawnResult;
      try {
        result = await spawnCommand(command, shellName, cwd, env, resolvedTimeoutMs, ctx);
      } catch (e) {
        return fail(describeError(e));
      }

      const lines: string[] = [];

      if (result.timedOut) {
        const secs = resolvedTimeoutMs !== null ? resolvedTimeoutMs / 1000 : "?";
        lines.push(`[Timed out after ${secs}s — process tree killed. Partial output below.]`);
      }

      if (result.stdoutTruncated) {
        lines.push("[stdout truncated at 1 MB]");
      }
      if (result.stderrTruncated) {
        lines.push("[stderr truncated at 1 MB]");
      }

      const summary = result.timedOut
        ? `Command timed out (${resolvedTimeoutMs !== null ? resolvedTimeoutMs / 1000 : "?"}s): ${command.slice(0, 80)}`
        : `Exit ${result.exitCode ?? "?"}: ${command.slice(0, 80)}`;

      const content = [
        lines.join("\n"),
        result.stdout ? `stdout:\n${result.stdout}` : "",
        result.stderr ? `stderr:\n${result.stderr}` : "",
        `exit code: ${result.exitCode ?? "null"}`,
      ]
        .filter(Boolean)
        .join("\n");

      return ok(content, {
        summary,
        terminal: {
          command,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        },
      });
    },
  },
];
