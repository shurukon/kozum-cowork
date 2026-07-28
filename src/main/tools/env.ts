/**
 * Environment variable tools.
 *
 * These operate on the agent process's own environment, not the user's shell.
 */

import type { Tool } from "./registry.ts";
import { ok, fail } from "./registry.ts";

function str(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}

export const envTools: Tool[] = [

  /* ----------------------------------------------------------------- env_get */
  {
    definition: {
      name: "env_get",
      title: "Get Environment Variable",
      description:
        "Read an environment variable from the agent's process. Returns the variable's " +
        "value, or fails if the variable is not set. Useful for reading API keys, paths, " +
        "or feature flags that were set before the agent started.",
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
        "across agent restarts.",
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
      process.env[name] = value;
      return ok(`Set ${name}=${value}`, {
        summary: `Set ${name} (session only)`,
      });
    },
  },
];
