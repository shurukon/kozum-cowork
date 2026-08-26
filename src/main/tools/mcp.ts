/**
 * MCP tools exposed to the agent.
 *
 * - mcp_install  — add a server, connect it, report tools (dangerous)
 * - mcp_list     — list configured servers
 * - mcp_remove   — remove a server
 * - mcp_call     — direct tool passthrough
 */

import type { Tool, ToolContext } from "./registry.ts";
import { ok, fail } from "./registry.ts";
import type { McpManager } from "../mcp/manager.ts";
import type { AskBroker } from "./ask.ts";
import type { McpPolicyAction, McpServerConfig, McpTransport } from "../../shared/types.ts";
import { detectTransport } from "../mcp/transport.ts";

let _idCounter = 1;
function genId(): string {
  return `mcp_${Date.now()}_${_idCounter++}`;
}

/**
 * Session-scoped "Always allow" cache for per-tool MCP policy prompts.
 * Intentionally process-lifetime only, mirroring the permission gate's
 * sessionAllowedTools semantics (discarded on restart).
 */
const mcpSessionAllowed = new Map<string, Set<string>>();

function normalizeDecision(value: string): "allow_once" | "allow_always" | "deny" {
  const normalized = value.trim().toLowerCase();
  if (["allow_always", "always", "allow always", "remember", "yes_always"].includes(normalized)) {
    return "allow_always";
  }
  if (["yes", "allow", "approve", "approved", "y", "true", "allow_once", "once", "allow once"].includes(normalized)) {
    return "allow_once";
  }
  return "deny";
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

/* ------------------------------------------------------ mcp_list_tools --- */

function makeMcpListTools(manager: McpManager): Tool {
  return {
    definition: {
      name: "mcp_list_tools",
      title: "List MCP Tools",
      description:
        "List every callable tool on the connected MCP servers with exact names, " +
        "descriptions and required arguments. Use this when a server exposes more " +
        "tools than fit in your context or before calling an unfamiliar tool.",
      icon: "list",
      group: "mcp",
      modes: ["cowork", "code"],
      inputSchema: {
        type: "object",
        properties: {
          serverId: {
            type: "string",
            description: "Optional server id. Omit to list every connected server.",
          },
        },
        additionalProperties: false,
      },
    },

    handler: async (input, _ctx) => {
      const only = typeof input["serverId"] === "string" ? (input["serverId"] as string) : undefined;
      const catalog = manager.toolCatalog().filter((s) => !only || s.id === only);
      if (only && catalog.length === 0) {
        const ids = manager.status().map((s) => s.id);
        return fail(
          ids.length
            ? `No connected MCP server with id "${only}". Connected: ${ids.join(", ")}.`
            : "No connected MCP servers.",
        );
      }
      if (catalog.length === 0) {
        const content = "No connected MCP servers.";
        return ok(content, { summary: "No MCP tools", detail: content });
      }
      const blocks = catalog.map((server) => {
        const lines = [`MCP server "${server.name}" (serverId: ${server.id}) — ${server.tools.length} tools:`];
        for (const t of server.tools) {
          const args = t.requiredArgs.length ? ` [required: ${t.requiredArgs.join(", ")}]` : "";
          lines.push(`  - ${t.name}${args} — ${t.description || "(no description)"}`);
        }
        return lines.join("\n");
      });
      const content = blocks.join("\n\n");
      return ok(content, { summary: `${catalog.reduce((n, s) => n + s.tools.length, 0)} MCP tools`, detail: content });
    },
  };
}

/* ---------------------------------------------------------- mcp_call --- */

/** Levenshtein distance capped for suggestion use (small strings). */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 99;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length]![b.length]!;
}

function makeMcpCall(manager: McpManager, ask: AskBroker): Tool {
  return {
    definition: {
      name: "mcp_call",
      title: "Call MCP Tool",
      description:
        "Call a tool on a specific MCP server directly. Tool names and required " +
        "arguments are listed in your system prompt per server; when unsure, call " +
        "`mcp_list_tools` first. Unknown names or missing required args fail fast.",
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
            description: "Arguments to pass to the tool (include every required arg)",
          },
        },
        additionalProperties: false,
      },
    },

    handler: async (input, ctx) => {
      const serverId = input["serverId"] as string;
      const toolName = input["tool"] as string;
      const args = input["args"] as Record<string, unknown> | undefined;

      /* ── Policy gate FIRST (deny wins even when down; asks happen before
         any existence validation so prompts are never phantom). ─────────── */
      const entry = manager.getEntry(serverId);
      if (!entry) {
        const ids = manager.status().map((s) => s.id);
        return fail(
          `Unknown MCP server "${serverId}". Connected servers: ${ids.length ? ids.join(", ") : "(none)"}.`,
        );
      }
      let action: McpPolicyAction = manager.effectiveToolAction(serverId, `mcp__${entry.config.name}__${toolName}`);
      const allowedCache = mcpSessionAllowed.get(ctx.sessionId) ?? new Set<string>();
      if (action === "ask" && allowedCache.has(`mcp__${entry.config.name}__${toolName}`)) {
        action = "allow";
      }

      if (action === "deny") {
        return fail(
          `Tool "mcp__${entry.config.name}__${toolName}" is blocked by user policy for this connector.`,
        );
      }
      if (action === "ask") {
        const namespaced = `mcp__${entry.config.name}__${toolName}`;
        const decision = await askMcpPolicy(ask, ctx, namespaced, entry.config.name);
        if (decision === "allow_always") {
          allowedCache.add(namespaced);
          mcpSessionAllowed.set(ctx.sessionId, allowedCache);
        } else if (decision !== "allow_once") {
          return fail(`Tool "${namespaced}" was blocked by user policy (denied).`);
        }
      }

      /* ── W2 fast-fail validation — runs once the gate is open, so a real
         allow is never wasted on a call that cannot succeed. ────────────── */
      const catalogEntry = manager.toolCatalog().find((s) => s.id === serverId);
      if (!catalogEntry) {
        return fail(`MCP server "${entry.config.name}" is not connected (status: ${entry.status}).`);
      }
      const def = catalogEntry.tools.find((t) => t.name === toolName);
      if (!def) {
        const all = catalogEntry.tools.map((t) => t.name);
        const close = all.filter((n) => editDistance(n.toLowerCase(), toolName.toLowerCase()) <= 2).slice(0, 5);
        return fail(
          `Tool "${toolName}" does not exist on "${entry.config.name}". Available (${all.length}): ${all.join(", ")}.` +
            (close.length ? ` Did you mean: ${close.join(", ")}?` : ""),
        );
      }
      const missing = def.requiredArgs.filter((k) => !args || !(k in args));
      if (missing.length > 0) {
        return fail(
          `Missing required argument(s) for "${toolName}": ${missing.join(", ")}. ` +
            `Supply them in args; see \`mcp_list_tools\` for the full schema.`,
        );
      }

      /* ── R5 live feedback: elapsed-time ticker so long media-generation
         calls (Higgsfield et al.) visibly progress instead of hanging. ──── */
      const startedAt = Date.now();
      const ticker = setInterval(() => {
        ctx.onProgress(`${entry.config.name}.${toolName}: ${Math.round((Date.now() - startedAt) / 1000)}s elapsed…`);
      }, 5000);

      let result;
      try {
        result = await manager.callTool(serverId, toolName, args);
      } finally {
        clearInterval(ticker);
      }
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);

      if (result.isError) {
        return fail(result.content, `mcp_call: ${toolName} returned error`);
      }

      /* ── R5 auto-preview: surface generated media the moment it exists.
         Scan the payload for image/video URLs and push the first one into
         the user's preview panel; also note it for the transcript. */
      let mediaNote = "";
      const mediaUrlMatch = result.content.match(
        /https?:\/\/[^\s"'<>\\]+\.(?:png|jpe?g|webp|gif|mp4|webm|mov)(?:\?[^\s"'<>\\]*)?/i,
      );
      if (mediaUrlMatch) {
        ctx.onPreviewOpen?.({ kind: "url", url: mediaUrlMatch[0] });
        mediaNote = ` Generated media auto-previewed: ${mediaUrlMatch[0]}`;
      }

      return ok(result.content, {
        summary: `mcp_call: ${toolName} (${elapsedSec}s)${mediaNote}`,
        detail: result.content,
      });
    },
  };
}

/**
 * AskBroker flow for a per-tool policy prompt, identical in shape to
 * ask_user_question: register with the broker (so sessions:reply reaches it),
 * emit through ctx.onQuestion, and race against the abort signal.
 */
async function askMcpPolicy(
  ask: AskBroker,
  ctx: ToolContext,
  namespaced: string,
  serverName: string,
): Promise<"allow_once" | "allow_always" | "deny"> {
  const question = `Allow "${namespaced}" on connector "${serverName}"?`;
  const options = [
    { label: "Allow once", value: "allow_once" },
    { label: "Always allow this session", value: "allow_always" },
    { label: "Deny", value: "deny" },
  ];
  const { requestId, promise } = ask.ask(ctx.sessionId, {
    question,
    options,
    multiSelect: false,
  });
  ctx.onQuestion?.({ requestId, question, options, multiSelect: false });

  const abortPromise = new Promise<never>((_res, rej) => {
    if (ctx.signal.aborted) {
      rej(new Error("Cancelled"));
      return;
    }
    ctx.signal.addEventListener("abort", () => rej(new Error("Cancelled")), { once: true });
  });

  try {
    const values = await Promise.race([promise, abortPromise]);
    return normalizeDecision(values[0] ?? "deny");
  } catch {
    ask.reject(requestId, "Cancelled by abort signal.");
    return "deny";
  }
}

/* ----------------------------------------------------------- export --- */

export function makeMcpTools(manager: McpManager, ask: AskBroker): Tool[] {
  return [
    makeMcpInstall(manager),
    makeMcpList(manager),
    makeMcpListTools(manager),
    makeMcpRemove(manager),
    makeMcpCall(manager, ask),
  ];
}
