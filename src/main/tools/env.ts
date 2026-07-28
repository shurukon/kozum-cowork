/**
 * Environment variable tools.
 *
 * These operate on the agent process's own environment, not the user's shell.
 *
 * Security notes (H11):
 *  - env_get masks values whose names match a secret-name pattern.  The full
 *    value is NOT returned to the model; only length + first/last 2 chars.
 *  - env_set refuses names that would affect process-loader behaviour
 *    (NODE_OPTIONS, LD_PRELOAD, PATH, etc.), because process.env is spread
 *    into every child process spawned by the shell tool.
 */

import type { Tool } from "./registry.ts";
import { ok, fail } from "./registry.ts";

function str(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}

/**
 * Pattern matching environment variable names that are likely to contain
 * secrets.  Matched case-insensitively.
 */
const SECRET_NAME_RE = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|_PAT$/i;

/**
 * Environment variable names that env_set must refuse.  These affect the
 * process loader or module resolution and are spread into every child process.
 */
const FORBIDDEN_SET_NAMES = new Set([
  "NODE_OPTIONS",
  "PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "PYTHONPATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
]);

/** Produce a masked representation of a secret value (length + first/last 2 chars). */
function maskSecret(name: string, value: string): string {
  const len = value.length;
  if (len === 0) return "(empty)";
  if (len <= 4) return "*".repeat(len);
  return value.slice(0, 2) + "*".repeat(len - 4) + value.slice(-2);
}

export const envTools: Tool[] = [

  /* ----------------------------------------------------------------- env_get */
  {
    definition: {
      name: "env_get",
      title: "Get Environment Variable",
      description:
        "Read an environment variable from the agent's process. Returns the variable's " +
        "value, or fails if the variable is not set. Useful for reading path settings, " +
        "feature flags, or locale information that were configured before the agent started. " +
        "Note: variables whose names suggest secrets (KEY, TOKEN, SECRET, PASSWORD, " +
        "CREDENTIAL, AUTH, _PAT) are returned masked — the full value is withheld as a " +
        "security measure.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Environment variable name (case-sensitive on Linux/macOS)." },
        },
        required: ["name"],
      },
      icon: "terminal",
      group: "system",
      modes: ["cowork", "code"],
    },
    async handler(input, _ctx) {
      const name = str(input["name"]);
      const value = process.env[name];
      if (value === undefined) {
        return fail(`Environment variable "${name}" is not set.`);
      }

      // H11: mask values that look like secrets so they cannot leak into the
      // model's context, transcript, or session store.
      if (SECRET_NAME_RE.test(name)) {
        const masked = maskSecret(name, value);
        return ok(
          `[MASKED — full value withheld for security] length=${value.length} preview="${masked}"`,
          {
            summary: `${name} = [masked, ${value.length} chars]`,
          },
        );
      }

      return ok(value, {
        summary: `${name} = ${value.length > 80 ? value.slice(0, 77) + "…" : value}`,
      });
    },
  },

  /* ----------------------------------------------------------------- env_set */
  {
    definition: {
      name: "env_set",
      title: "Set Environment Variable",
      description:
        "Set an environment variable for the current agent process session. " +
        "IMPORTANT: this only affects the agent's own process and any child processes " +
        "it spawns going forward. It does NOT modify the user's system environment, " +
        "shell profile, or any already-running processes. The change is not persisted " +
        "across agent restarts. " +
        "The following names are refused because they affect the process loader or " +
        "module resolution and are inherited by all child processes: " +
        "NODE_OPTIONS, PATH, LD_PRELOAD, LD_LIBRARY_PATH, PYTHONPATH, " +
        "DYLD_INSERT_LIBRARIES, DYLD_LIBRARY_PATH.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Environment variable name." },
          value: { type: "string", description: "Value to set." },
        },
        required: ["name", "value"],
      },
      icon: "settings",
      group: "system",
      modes: ["cowork", "code"],
    },
    async handler(input, _ctx) {
      const name = str(input["name"]);
      const value = str(input["value"]);

      // H11: refuse names that affect the process loader / module resolution.
      // These are spread into every child process the shell tool spawns, so a
      // hostile value (e.g. NODE_OPTIONS=--require=/tmp/evil.js) would affect
      // all subsequent shell commands.
      if (FORBIDDEN_SET_NAMES.has(name.toUpperCase()) || FORBIDDEN_SET_NAMES.has(name)) {
        return fail(
          `Refusing to set "${name}": this variable affects the process loader or ` +
            "module resolution and is inherited by all child processes. " +
            "Setting it could be exploited to execute arbitrary code in subsequent " +
            "shell commands.",
        );
      }

      process.env[name] = value;
      return ok(`Set ${name}=${value}`, {
        summary: `Set ${name} (session only)`,
      });
    },
  },
];
