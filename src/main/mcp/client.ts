/**
 * MCP client.
 *
 * Implements the Model Context Protocol client handshake and RPC calls over
 * any McpTransportImpl. Handles:
 *   - Request/response correlation by id
 *   - Pending-request timeouts
 *   - Server-initiated notifications (logged, not acted on by default)
 *   - Clean shutdown
 *
 * Does NOT import @modelcontextprotocol/sdk — wire protocol is in protocol.ts.
 */

import type { McpTransportImpl } from "./transport.ts";
import {
  rpcRequest,
  rpcNotification,
  parseRpcMessage,
  isSuccess,
  isRpcError,
  isNotification,
} from "./protocol.ts";

/* ------------------------------------------------------ result shapes --- */

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpToolsListResult {
  tools: McpToolDefinition[];
}

export interface McpCallToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
}

/* ----------------------------------------------------- McpClient ------- */

const DEFAULT_TIMEOUT_MS = 30_000;

export class McpClient {
  private idCounter = 1;
  private pending = new Map<
    string | number,
    {
      resolve: (result: unknown) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private notificationHandlers: Array<(method: string, params: unknown) => void> = [];
  private initialized = false;

  private readonly transport: McpTransportImpl;
  private readonly timeoutMs: number;

  constructor(transport: McpTransportImpl, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    transport.onMessage((raw) => this.handleRaw(raw));
  }

  private nextId(): number {
    return this.idCounter++;
  }

  private handleRaw(raw: string): void {
    const result = parseRpcMessage(raw);
    if (!result.ok) return; // Malformed — ignore

    const msg = result.message;

    if (isNotification(msg)) {
      for (const h of this.notificationHandlers) h(msg.method, msg.params);
      return;
    }

    if (isSuccess(msg) || isRpcError(msg)) {
      const id = msg.id;
      if (id === null || id === undefined) return;
      const entry = this.pending.get(id);
      if (!entry) return;

      clearTimeout(entry.timer);
      this.pending.delete(id);

      if (isRpcError(msg)) {
        entry.reject(new Error(`RPC error ${msg.error.code}: ${msg.error.message}`));
      } else {
        entry.resolve(msg.result);
      }
    }
  }

  /** Register a handler for server-initiated notifications. */
  onNotification(cb: (method: string, params: unknown) => void): void {
    this.notificationHandlers.push(cb);
  }

  /** Send a request and wait for the correlated response. */
  private request<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });

      const msg = rpcRequest(id, method, params);
      this.transport.send(msg).catch((err: unknown) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  /**
   * Perform the MCP initialize handshake.
   *
   * 1. Send `initialize` with client capabilities.
   * 2. Receive the server's `initialize` result.
   * 3. Send `notifications/initialized` (no response expected).
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // If the transport needs an SSE stream opened first, do it.
    const sseT = this.transport as { openStream?: () => Promise<void> };
    if (typeof sseT.openStream === "function") {
      await sseT.openStream();
    }

    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      clientInfo: { name: "kozum-cowork", version: "0.1.0" },
    });

    // Send initialized notification (fire and forget)
    const notif = rpcNotification("notifications/initialized");
    await this.transport.send(notif).catch(() => undefined);

    this.initialized = true;
  }

  /** List available tools on the server. */
  async listTools(): Promise<McpToolDefinition[]> {
    const result = await this.request<McpToolsListResult>("tools/list");
    return result.tools ?? [];
  }

  /** Call a tool on the server. */
  async callTool(name: string, args?: Record<string, unknown>): Promise<McpCallToolResult> {
    const result = await this.request<McpCallToolResult>("tools/call", {
      name,
      arguments: args ?? {},
    });
    return result;
  }

  /** Close the transport and reject all pending requests. */
  async close(): Promise<void> {
    // Reject all pending
    for (const [id, entry] of this.pending.entries()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("McpClient closed"));
      this.pending.delete(id);
    }
    await this.transport.close();
  }
}
