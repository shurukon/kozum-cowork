/**
 * MCP tools exposed to the agent.
 *
 * - mcp_install  — add a server, connect it, report tools (dangerous)
 * - mcp_list     — list configured servers
 * - mcp_remove   — remove a server
 * - mcp_call     — direct tool passthrough
 */

import type { Tool } from "./registry.ts";
import { ok, fail } from "./registry.ts";
import type { McpManager } from "../mcp/manager.ts";
import type { McpServerConfig, McpTransport } from "../../shared/types.ts";
import { detectTransport } from "../mcp/transport.ts";

let _idCounter = 1;
function genId(): string {
  return `mcp_${Date.now()}_${_idCounter++}`;
}

/* -------------------------------------------------------- helpers ------ */

function toStringRecord(raw: unknown): Record<string, string> | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    out[k] = String(v);
  }
  return out;
}

function toStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.map(String);
}

/* -------------------------------------------------------- mcp_install --- */

function makeMcpInstall(manager: McpManager): Tool {
  return {
    definition: {
      name: "mcp_install",
      title: "Install MCP Server",
      description:
        "Add and connect an MCP server so its tools become immediately available. " +
        "Provide a URL for HTTP/SSE servers or a command for stdio servers. " +
        "Transport is auto-detected when using a URL.",
      icon: "plug",
      group: "mcp",
      dangerous: true,
      modes: ["cowork", "code"],
      inputSchema: {
        type: "object",
        required: ["name"],
        properties: {
          name: {
            type: "string",
            description: "Short identifier for the server (used in tool namespacing)",
          },
          url: {
            type: "string",
            description: "Server URL for HTTP or SSE transport",
          },
          authToken: {
            type: "string",
            description: "Bearer token or API key for authentication",
          },
          authHeader: {
            type: "string",
            description: "Custom header name for the auth token (default: Authorization)",
          },
          command: {
            type: "string",
            description: "Command to spawn for stdio transport (Advanced)",
          },
          args: {
            type: "array",
            description: "Arguments for the stdio command",
            items: { type: "string" },
          },
          env: {
            type: "object",
            description: "Environment variables for the stdio command",
          },
          transport: {
            type: "string",
            description: "Transport type: http, sse, or stdio (auto-detected when url is given)",
            enum: ["http", "sse", "stdio"],
          },
          allowLocal: {
            type: "boolean",
            description:
              "Set true to allow connections to localhost/127.x.x.x. " +
              "Required for local development MCP servers. SSRF protections " +
              "still block non-localhost private addresses.",
          },
        },
        additionalProperties: false,
      },
    },

    handler: async (input, _ctx) => {
      const name = input["name"] as string;
      const url = input["url"] as string | undefined;
      const authToken = input["authToken"] as string | undefined;
      const authHeader = input["authHeader"] as string | undefined;
      const command = input["command"] as string | undefined;
      const rawArgs = input["args"];
      const rawEnv = input["env"];
      const transportOverride = input["transport"] as McpTransport | undefined;
      const allowLocal = input["allowLocal"] === true;

      const args = toStringArray(rawArgs);
      const env = toStringRecord(rawEnv);

      // Validate: need either url or command
      if (!url && !command) {
        return fail("mcp_install requires either a url or a command");
      }

      // Determine transport
      let transport: McpTransport;
      if (transportOverride) {
        transport = transportOverride;
      } else if (command) {
        transport = "stdio";
      } else {
        // Auto-detect from URL
        const headers: Record<string, string> = {};
        if (authToken) {
          const hdr = authHeader ?? "Authorization";
          headers[hdr] = hdr.toLowerCase() === "authorization"
            ? `Bearer ${authToken}`
            : authToken;
        }
        transport = await detectTransport(url!, headers, { allowLocal });
      }

      const id = genId();
      const config: McpServerConfig = {
        id,
        name,
        enabled: true,
        transport,
        url,
        hasAuthToken: Boolean(authToken),
        authHeader,
        command,
        args,
        env,
        createdAt: Date.now(),
        installedByAgent: true,
        status: "connecting",
        toolCount: 0,
        allowLocal,
      };

      let added = false;
      try {
        await manager.add(config);
        added = true;

        await manager.connect(id, { authToken });

        const entry = manager.getEntry(id);
        if (entry?.status === "error") {
          throw new Error(entry.statusMessage ?? "Connection failed");
        }

        const tools = manager.allTools().filter((t) => t.serverId === id);
        const toolList = tools.map((t) => t.name).join(", ");
        const summary = tools.length > 0
          ? `Connected to "${name}" — ${tools.length} tool${tools.length === 1 ? "" : "s"} available: ${toolList}`
          : `Connected to "${name}" — no tools exposed`;

        return ok(summary, { summary, detail: toolList || "No tools" });
      } catch (err) {
        // On failure, remove the half-added server
        if (added) {
          await manager.remove(id).catch(() => undefined);
        }
        const msg = err instanceof Error ? err.message : String(err);
        return fail(`Failed to install MCP server "${name}": ${msg}`);
      }
    },
  };
}

/* ---------------------------------------------------------- mcp_list --- */

function makeMcpList(manager: McpManager): Tool {
  return {
    definition: {
      name: "mcp_list",
      title: "List MCP Servers",
      description: "List all configured MCP servers with their status and tool counts.",
      icon: "list",
      group: "mcp",
      modes: ["cowork", "code"],
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },

    handler: async (_input, _ctx) => {
      const servers = manager.status();
      if (servers.length === 0) {
        return ok("No MCP servers configured.", { summary: "No MCP servers" });
      }

      const lines = servers.map((s) => {
        const statusMark = s.status === "connected" ? "✓" : s.status === "error" ? "✗" : "○";
        const errSuffix = s.statusMessage ? ` — ${s.statusMessage}` : "";
        return `${statusMark} [${s.id}] ${s.name}  (${s.transport})  status=${s.status}  tools=${s.toolCount}${errSuffix}`;
      });

      const content = lines.join("\n");
      return ok(content, {
        summary: `${servers.length} MCP server${servers.length === 1 ? "" : "s"}`,
        detail: content,
      });
    },
  };
}

/* -------------------------------------------------------- mcp_remove --- */

function makeMcpRemove(manager: McpManager): Tool {
  return {
    definition: {
      name: "mcp_remove",
      title: "Remove MCP Server",
      description: "Remove an MCP server by id, closing its connection.",
      icon: "trash",
      group: "mcp",
      modes: ["cowork", "code"],
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: {
          id: {
            type: "string",
            description: "The server id to remove",
          },
        },
        additionalProperties: false,
      },
    },

    handler: async (input, _ctx) => {
      const id = input["id"] as string;
      const servers = manager.status();
      const found = servers.find((s) => s.id === id);
      if (!found) {
        return fail(`No MCP server with id "${id}"`);
      }
      await manager.remove(id);
      return ok(`Removed MCP server "${found.name}" (${id})`, {
        summary: `Removed ${found.name}`,
      });
    },
  };
}

/* ---------------------------------------------------------- mcp_call --- */

function makeMcpCall(manager: McpManager): Tool {
  return {
    definition: {
      name: "mcp_call",
      title: "Call MCP Tool",
      description: "Call a tool on a specific MCP server directly.",
      icon: "zap",
      group: "mcp",
      modes: ["cowork", "code"],
      inputSchema: {
        type: "object",
        required: ["serverId", "tool"],
        properties: {
          serverId: {
            type: "string",
            description: "The server id",
          },
          tool: {
            type: "string",
            description: "The tool name (bare, without the mcp__server__ prefix)",
          },
          args: {
            type: "object",
            description: "Arguments to pass to the tool",
          },
        },
        additionalProperties: false,
      },
    },

    handler: async (input, _ctx) => {
      const serverId = input["serverId"] as string;
      const toolName = input["tool"] as string;
      const args = input["args"] as Record<string, unknown> | undefined;

      const result = await manager.callTool(serverId, toolName, args);

      if (result.isError) {
        return fail(result.content, `mcp_call: ${toolName} returned error`);
      }

      return ok(result.content, {
        summary: `mcp_call: ${toolName}`,
        detail: result.content,
      });
    },
  };
}

/* ----------------------------------------------------------- export --- */

export function makeMcpTools(manager: McpManager): Tool[] {
  return [
    makeMcpInstall(manager),
    makeMcpList(manager),
    makeMcpRemove(manager),
    makeMcpCall(manager),
  ];
}
