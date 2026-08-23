/**
 * MCP Manager.
 *
 * Holds many MCP server connections. Each server is fully isolated: one dead
 * server does not block or error the others.
 *
 * Tool names are namespaced: mcp__<serverName>__<toolName>
 */

import type { McpConnectionTest, McpPolicyAction, McpServerConfig, McpStatus, McpToolInfo, McpToolPolicy } from "../../shared/types.ts";
import { McpClient } from "./client.ts";
import type { McpToolDefinition } from "./client.ts";
import { createTransport } from "./transport.ts";
import { readJson, writeJson } from "../store/json.ts";
import type { SecretStore } from "../store/secrets.ts";

/* -------------------------------------------------------- server entry --- */

interface ServerEntry {
  config: McpServerConfig;
  client: McpClient | null;
  tools: McpToolDefinition[];
  status: McpStatus;
  statusMessage?: string;
}

/* ----------------------------------------------------------- manager --- */

interface McpFile {
  servers: McpServerConfig[];
}

export class McpManager {
  private servers = new Map<string, ServerEntry>();
  private readonly filePath?: string;
  private readonly secrets?: SecretStore;
  private readonly tokenIds = new Map<string, string>();
  private loaded = false;
  private loading: Promise<void> | null = null;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(filePath?: string, secrets?: SecretStore) {
    this.filePath = filePath;
    this.secrets = secrets;
  }

  /** Load persisted configs once. Runtime status is always reset on boot. */
  async load(): Promise<void> {
    await this.ensureLoaded();
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      if (this.filePath) {
        const data = await readJson<McpFile>(this.filePath, { servers: [] });
        for (const raw of Array.isArray(data.servers) ? data.servers : []) {
          if (!raw || typeof raw.id !== "string" || typeof raw.name !== "string") continue;
          this.servers.set(raw.id, {
            config: {
              ...raw,
              status: "disconnected",
              statusMessage: undefined,
              toolCount: 0,
            },
            client: null,
            tools: [],
            status: "disconnected",
          });
        }
      }
      this.loaded = true;
    })();
    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }

  private persist(): Promise<void> {
    if (!this.filePath) return Promise.resolve();
    this.persistQueue = this.persistQueue.then(async () => {
      const servers = [...this.servers.values()].map((entry) => ({
        ...entry.config,
        status: "disconnected" as const,
        statusMessage: undefined,
        toolCount: 0,
      }));
      await writeJson(this.filePath!, { servers });
    });
    return this.persistQueue;
  }

  /** Store or replace a server token in the OS-backed secret store. */
  async setAuthToken(id: string, token?: string): Promise<void> {
    if (!token || !this.secrets) return;
    const providerId = `mcp:${id}`;
    // Add first so a transient secret-store failure never destroys the token
    // that is currently working. Cleanup of older records follows only after
    // the replacement has been committed.
    const replacement = await this.secrets.add(providerId, "MCP authentication", token);
    const previous = await this.secrets.list(providerId);
    for (const record of previous) {
      if (record.id !== replacement.id) {
        await this.secrets.remove(record.id);
      }
    }
    this.tokenIds.set(id, replacement.id);
  }

  private async authTokenFor(id: string): Promise<string | undefined> {
    if (!this.secrets) return undefined;
    const cachedId = this.tokenIds.get(id);
    if (cachedId) return (await this.secrets.reveal(cachedId)) ?? undefined;
    const records = await this.secrets.list(`mcp:${id}`);
    const first = records[0];
    if (!first) return undefined;
    this.tokenIds.set(id, first.id);
    return (await this.secrets.reveal(first.id)) ?? undefined;
  }

  /** Add a server configuration (does not connect — call connect() after). */
  async add(config: McpServerConfig): Promise<void> {
    await this.ensureLoaded();
    if (this.servers.has(config.id)) {
      throw new Error(`MCP server "${config.id}" is already registered`);
    }
    this.servers.set(config.id, {
      // Newly added servers ask for every tool until the user opts out.
      config: { ...config, toolPolicy: config.toolPolicy ?? { default: "ask" }, status: "disconnected", toolCount: 0 },
      client: null,
      tools: [],
      status: "disconnected",
    });
    await this.persist();
  }

  /**
   * Replace a server's tool policy and persist it. No reconnect is required —
   * the policy is evaluated per call inside the mcp_call gate.
   */
  async setToolPolicy(id: string, policy: McpToolPolicy): Promise<McpServerConfig | null> {
    await this.ensureLoaded();
    const entry = this.servers.get(id);
    if (!entry) return null;
    const merged: McpToolPolicy = {
      default: policy.default ?? entry.config.toolPolicy?.default ?? "ask",
      ...(policy.tools !== undefined ? { tools: { ...policy.tools } } : {}),
    };
    entry.config = { ...entry.config, toolPolicy: merged };
    await this.persist();
    return this.status().find((s) => s.id === id) ?? null;
  }

  /**
   * Effective policy action for one namespaced tool name
   * (`mcp__<server>__<tool>`). Per-tool overrides win over the default.
   * Unknown servers resolve to "ask" (fail closed).
   */
  effectiveToolAction(serverId: string, namespacedName: string): McpPolicyAction {
    const entry = this.servers.get(serverId);
    if (!entry) return "ask";
    const policy = entry.config.toolPolicy;
    if (!policy) return "ask";
    const bare = namespacedName.startsWith(`mcp__${entry.config.name}__`)
      ? namespacedName.slice(`mcp__${entry.config.name}__`.length)
      : namespacedName;
    return policy.tools?.[bare] ?? policy.default;
  }

  /** Remove a server and close its connection. */
  async remove(id: string): Promise<void> {
    await this.ensureLoaded();
    const entry = this.servers.get(id);
    if (!entry) return;
    if (entry.client) {
      await entry.client.close().catch(() => undefined);
    }
    this.servers.delete(id);
    if (this.secrets) {
      const providerId = `mcp:${id}`;
      for (const record of await this.secrets.list(providerId)) {
        await this.secrets.remove(record.id).catch(() => undefined);
      }
    }
    this.tokenIds.delete(id);
    await this.persist();
  }

  /** Enable a server (does not reconnect automatically). */
  async enable(id: string): Promise<void> {
    await this.ensureLoaded();
    const entry = this.servers.get(id);
    if (entry) {
      entry.config = { ...entry.config, enabled: true };
      await this.persist();
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
    entry.config = { ...entry.config, toolCount: 0 };
    await this.persist();
  }

  /** Connect to a single server by id. Safe to call even if already connected. */
  async connect(
    id: string,
    opts: { authToken?: string } = {},
  ): Promise<void> {
    await this.ensureLoaded();
    const entry = this.servers.get(id);
    if (!entry) throw new Error(`Unknown MCP server: ${id}`);
    if (!entry.config.enabled) return;
    if (opts.authToken) await this.setAuthToken(id, opts.authToken);

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
        authToken: opts.authToken ?? await this.authTokenFor(id),
        authHeader: entry.config.authHeader,
        allowLocal: entry.config.allowLocal,
      });

      const client = new McpClient(transport);
      await client.initialize();
      const tools = await client.listTools();

      entry.client = client;
      entry.tools = tools;
      entry.status = "connected";
      entry.config = { ...entry.config, toolCount: tools.length };
      await this.persist();
    } catch (err) {
      entry.client = null;
      entry.tools = [];
      entry.status = "error";
      entry.statusMessage = err instanceof Error ? err.message : String(err);
      entry.config = { ...entry.config, toolCount: 0 };
      await this.persist();
    }
  }

  /**
   * Perform a real initialize + tools/list handshake without persisting or
   * registering the server. This is used by Customize's Test connection flow
   * so malformed or unreachable endpoints are rejected before mcp:add.
   */
  async testConnection(
    config: Pick<McpServerConfig, "transport" | "url" | "command" | "args" | "env" | "authHeader" | "allowLocal">,
    opts: { authToken?: string } = {},
  ): Promise<McpConnectionTest> {
    const transport = createTransport(config.transport, {
      url: config.url,
      command: config.command,
      args: config.args,
      env: config.env,
      authToken: opts.authToken,
      authHeader: config.authHeader,
      allowLocal: config.allowLocal,
    });
    const client = new McpClient(transport);
    try {
      await client.initialize();
      const tools = await client.listTools();
      return {
        transport: config.transport,
        toolCount: tools.length,
        toolNames: tools.map((tool) => tool.name),
      };
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  /** Connect to all enabled servers. Errors on individual servers are swallowed. */
  async connectAll(tokenMap: Record<string, string> = {}): Promise<void> {
    await this.ensureLoaded();
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
