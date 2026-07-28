/**
 * MCP Manager.
 *
 * Holds many MCP server connections. Each server is fully isolated: one dead
 * server does not block or error the others.
 *
 * Tool names are namespaced: mcp__<serverName>__<toolName>
 */

import type { McpServerConfig, McpStatus, McpToolInfo } from "../../shared/types.ts";
import { McpClient } from "./client.ts";
import type { McpToolDefinition } from "./client.ts";
import { createTransport } from "./transport.ts";

/* -------------------------------------------------------- server entry --- */

interface ServerEntry {
  config: McpServerConfig;
  client: McpClient | null;
  tools: McpToolDefinition[];
  status: McpStatus;
  statusMessage?: string;
}

/* ----------------------------------------------------------- manager --- */

export class McpManager {
  private servers = new Map<string, ServerEntry>();

  /** Add a server configuration (does not connect — call connect() after). */
  add(config: McpServerConfig): void {
    if (this.servers.has(config.id)) {
      throw new Error(`MCP server "${config.id}" is already registered`);
    }
    this.servers.set(config.id, {
      config,
      client: null,
      tools: [],
      status: "disconnected",
    });
  }

  /** Remove a server and close its connection. */
  async remove(id: string): Promise<void> {
    const entry = this.servers.get(id);
    if (!entry) return;
    if (entry.client) {
      await entry.client.close().catch(() => undefined);
    }
    this.servers.delete(id);
  }

  /** Enable a server (does not reconnect automatically). */
  enable(id: string): void {
    const entry = this.servers.get(id);
    if (entry) {
      entry.config = { ...entry.config, enabled: true };
    }
  }

  /** Disable a server and close its connection. */
  async disable(id: string): Promise<void> {
    const entry = this.servers.get(id);
    if (!entry) return;
    if (entry.client) {
      await entry.client.close().catch(() => undefined);
      entry.client = null;
    }
    entry.config = { ...entry.config, enabled: false };
    entry.status = "disconnected";
    entry.tools = [];
  }

  /** Connect to a single server by id. Safe to call even if already connected. */
  async connect(
    id: string,
    opts: { authToken?: string } = {},
  ): Promise<void> {
    const entry = this.servers.get(id);
    if (!entry) throw new Error(`Unknown MCP server: ${id}`);
    if (!entry.config.enabled) return;

    // Close any existing connection
    if (entry.client) {
      await entry.client.close().catch(() => undefined);
      entry.client = null;
    }

    entry.status = "connecting";
    entry.statusMessage = undefined;

    try {
      const transport = createTransport(entry.config.transport, {
        url: entry.config.url,
        command: entry.config.command,
        args: entry.config.args,
        env: entry.config.env,
        authToken: opts.authToken,
        authHeader: entry.config.authHeader,
      });

      const client = new McpClient(transport);
      await client.initialize();
      const tools = await client.listTools();

      entry.client = client;
      entry.tools = tools;
      entry.status = "connected";
      entry.config = { ...entry.config, toolCount: tools.length };
    } catch (err) {
      entry.client = null;
      entry.tools = [];
      entry.status = "error";
      entry.statusMessage = err instanceof Error ? err.message : String(err);
      entry.config = { ...entry.config, toolCount: 0 };
    }
  }

  /** Connect to all enabled servers. Errors on individual servers are swallowed. */
  async connectAll(tokenMap: Record<string, string> = {}): Promise<void> {
    const tasks = [...this.servers.values()]
      .filter((e) => e.config.enabled)
      .map((e) =>
        this.connect(e.config.id, { authToken: tokenMap[e.config.id] }).catch(
          () => undefined,
        ),
      );
    await Promise.all(tasks);
  }

  /** Snapshot of per-server status. */
  status(): McpServerConfig[] {
    return [...this.servers.values()].map((e) => ({
      ...e.config,
      status: e.status,
      statusMessage: e.statusMessage,
      toolCount: e.tools.length,
    }));
  }

  /** All tools across all connected servers, namespaced. */
  allTools(): McpToolInfo[] {
    const out: McpToolInfo[] = [];
    for (const entry of this.servers.values()) {
      if (entry.status !== "connected") continue;
      for (const tool of entry.tools) {
        out.push({
          serverId: entry.config.id,
          serverName: entry.config.name,
          name: `mcp__${entry.config.name}__${tool.name}`,
          description: tool.description ?? "",
          inputSchema: tool.inputSchema ?? {},
        });
      }
    }
    return out;
  }

  /** Call a tool on a specific server. Returns the raw result content. */
  async callTool(
    serverId: string,
    toolName: string,
    args?: Record<string, unknown>,
  ): Promise<{ ok: boolean; content: string; isError: boolean }> {
    const entry = this.servers.get(serverId);
    if (!entry) {
      return { ok: false, content: `Unknown MCP server: ${serverId}`, isError: true };
    }
    if (!entry.client) {
      return { ok: false, content: `Server "${entry.config.name}" is not connected`, isError: true };
    }

    try {
      const result = await entry.client.callTool(toolName, args);
      const text = result.content
        .map((c) => (typeof c.text === "string" ? c.text : JSON.stringify(c)))
        .join("\n");
      const isError = result.isError === true;
      return { ok: !isError, content: text, isError };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, content: msg, isError: true };
    }
  }

  /** Get a server entry for internal use. */
  getEntry(id: string): ServerEntry | undefined {
    return this.servers.get(id);
  }
}
