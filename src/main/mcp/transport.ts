/**
 * MCP transport implementations.
 *
 * Three transports, one interface:
 *   - HttpTransport  — streamable HTTP (POST, optional SSE response body)
 *   - SseTransport   — legacy SSE (GET SSE for server→client, POST for client→server)
 *   - StdioTransport — spawn a local process, newline-delimited JSON over stdin/stdout
 *
 * `detectTransport` probes streamable-HTTP first, falls back to SSE.
 * None of this imports @modelcontextprotocol/sdk; it implements the wire directly.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { McpTransport } from "../../shared/types.ts";
import { parseRpcMessage } from "./protocol.ts";

/* -------------------------------------------------- shared interface ---- */

export interface McpTransportImpl {
  send(msg: unknown): Promise<void>;
  onMessage(cb: (raw: string) => void): void;
  close(): Promise<void>;
}

/* ===================================================== HttpTransport ===== */

/**
 * Streamable HTTP transport (2024 spec).
 *
 * Every client→server message is a POST to the endpoint URL.
 * The server MAY respond with `text/event-stream` (SSE) instead of JSON,
 * in which case we parse the stream and surface each `data:` line as a message.
 */
export class HttpTransport implements McpTransportImpl {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private callbacks: Array<(raw: string) => void> = [];

  constructor(url: string, headers: Record<string, string> = {}) {
    this.url = url;
    this.headers = headers;
  }

  onMessage(cb: (raw: string) => void): void {
    this.callbacks.push(cb);
  }

  private emit(raw: string): void {
    for (const cb of this.callbacks) cb(raw);
  }

  async send(msg: unknown): Promise<void> {
    const body = JSON.stringify(msg);
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...this.headers,
      },
      body,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 256)}`);
    }

    const ct = res.headers.get("content-type") ?? "";

    if (ct.includes("text/event-stream")) {
      // Server responded with an SSE stream; read and emit all events.
      await this.consumeSse(res);
    } else {
      // Plain JSON response
      const text = await res.text();
      if (text.trim()) this.emit(text.trim());
    }
  }

  private async consumeSse(res: Response): Promise<void> {
    const reader = res.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";

      for (const line of lines) {
        if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          if (data && data !== "[DONE]") this.emit(data);
        }
      }
    }

    // Flush remaining buffer
    if (buf.startsWith("data:")) {
      const data = buf.slice(5).trim();
      if (data && data !== "[DONE]") this.emit(data);
    }
  }

  async close(): Promise<void> {
    // Stateless HTTP — nothing to close.
  }
}

/* ====================================================== SseTransport ===== */

/**
 * Legacy SSE transport.
 *
 * - Client→server: POST to `<url>`
 * - Server→client: GET SSE stream from `<url>` (or `<url>/sse`)
 *
 * The SSE stream may carry a `endpoint` event whose data is the URL to POST to.
 */
export class SseTransport implements McpTransportImpl {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private callbacks: Array<(raw: string) => void> = [];
  private postUrl: string;
  private abortController: AbortController | null = null;
  private streamClosed = false;
  private streamPromise: Promise<void> | null = null;
  // Resolves once the server's first event is received (endpoint or any data).
  private readyResolve: (() => void) | null = null;
  private readyReject: ((e: Error) => void) | null = null;
  private ready: Promise<void>;

  constructor(baseUrl: string, headers: Record<string, string> = {}) {
    this.baseUrl = baseUrl;
    this.headers = headers;
    this.postUrl = baseUrl;
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
  }

  onMessage(cb: (raw: string) => void): void {
    this.callbacks.push(cb);
  }

  private emit(raw: string): void {
    for (const cb of this.callbacks) cb(raw);
  }

  /**
   * Open the SSE stream and wait until the server has sent the first event
   * (usually an `endpoint` event telling us where to POST).
   */
  async openStream(): Promise<void> {
    this.abortController = new AbortController();
    const { signal } = this.abortController;

    const sseUrl = this.baseUrl.endsWith("/sse")
      ? this.baseUrl
      : `${this.baseUrl}/sse`;

    const res = await fetch(sseUrl, {
      headers: {
        Accept: "text/event-stream",
        ...this.headers,
      },
      signal,
    });

    if (!res.ok) {
      const err = new Error(`SSE connect failed: HTTP ${res.status}`);
      this.readyReject?.(err);
      throw err;
    }

    this.streamPromise = this.readStream(res).catch((e: unknown) => {
      // If stream dies before we signalled ready, surface that error.
      const err = e instanceof Error ? e : new Error(String(e));
      this.readyReject?.(err);
    });

    // Wait until the server has sent its initial event (endpoint or otherwise).
    await this.ready;
  }

  private async readStream(res: Response): Promise<void> {
    const reader = res.body?.getReader();
    if (!reader) {
      this.readyResolve?.();
      return;
    }

    const decoder = new TextDecoder();
    let buf = "";
    let eventType = "message";
    let dataLines: string[] = [];
    let signalledReady = false;

    while (!this.streamClosed) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";

      for (const line of lines) {
        if (line === "") {
          // Dispatch accumulated event
          if (dataLines.length > 0) {
            const data = dataLines.join("\n");
            if (eventType === "endpoint") {
              // Server sends the POST endpoint URL
              const endpoint = data.trim();
              if (endpoint.startsWith("http")) {
                this.postUrl = endpoint;
              } else {
                try {
                  const base = new URL(this.baseUrl);
                  this.postUrl = new URL(endpoint, base).toString();
                } catch {
                  this.postUrl = endpoint;
                }
              }
              // Signal ready after receiving the endpoint
              if (!signalledReady) {
                signalledReady = true;
                this.readyResolve?.();
              }
            } else if (data && data !== "[DONE]") {
              this.emit(data);
            }
          }
          // Signal ready on any dispatched event (even non-endpoint)
          if (!signalledReady && dataLines.length > 0) {
            signalledReady = true;
            this.readyResolve?.();
          }
          eventType = "message";
          dataLines = [];
        } else if (line.startsWith("event:")) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }

      // Ensure readyResolve fires even if there was no blank-line dispatch yet.
      if (!signalledReady && buf.length > 0) {
        signalledReady = true;
        this.readyResolve?.();
      }
    }
  }

  async send(msg: unknown): Promise<void> {
    const body = JSON.stringify(msg);
    const res = await fetch(this.postUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.headers,
      },
      body,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`SSE POST HTTP ${res.status}: ${text.slice(0, 256)}`);
    }

    // Some legacy servers echo the response in the POST body
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const text = await res.text();
      if (text.trim()) this.emit(text.trim());
    } else {
      // Drain body
      await res.text().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    this.streamClosed = true;
    this.abortController?.abort();
    if (this.streamPromise) {
      await this.streamPromise.catch(() => undefined);
    }
  }
}

/* ==================================================== StdioTransport ===== */

/**
 * stdio transport.
 *
 * Spawns a local process; JSON-RPC messages are newline-delimited on stdin/stdout.
 * stderr is ignored (many MCP servers log there; that is fine).
 */
export class StdioTransport implements McpTransportImpl {
  private readonly proc: ChildProcess;
  private callbacks: Array<(raw: string) => void> = [];
  private closed = false;
  private buf = "";

  constructor(command: string, args: string[] = [], env: Record<string, string> = {}) {
    this.proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });

    this.proc.stdout?.setEncoding("utf8");
    this.proc.stdout?.on("data", (chunk: string) => {
      this.buf += chunk;
      const lines = this.buf.split("\n");
      this.buf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) this.emit(trimmed);
      }
    });

    this.proc.on("error", (_err) => {
      // Process spawn error — close silently; callers will get timeouts.
    });
  }

  onMessage(cb: (raw: string) => void): void {
    this.callbacks.push(cb);
  }

  private emit(raw: string): void {
    for (const cb of this.callbacks) cb(raw);
  }

  async send(msg: unknown): Promise<void> {
    if (this.closed) throw new Error("StdioTransport: already closed");
    const line = JSON.stringify(msg) + "\n";
    return new Promise((resolve, reject) => {
      this.proc.stdin?.write(line, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.proc.stdin?.end();

    // Give the process a short window to exit cleanly, then kill it.
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.proc.kill("SIGTERM");
        resolve();
      }, 2000);

      this.proc.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  /** Exposed for tests: resolves when the child process has exited. */
  waitForExit(): Promise<number | null> {
    return new Promise((resolve) => {
      if (this.proc.exitCode !== null) {
        resolve(this.proc.exitCode);
        return;
      }
      this.proc.on("exit", (code) => resolve(code));
    });
  }
}

/* ================================================= detectTransport ====== */

/**
 * Auto-detect transport type from a URL.
 *
 * Probes streamable-HTTP (POST with Accept: application/json) first.
 * Falls back to SSE if the server returns 4xx on POST or does not accept JSON.
 *
 * Returns the McpTransport string used in McpServerConfig.
 */
export async function detectTransport(
  url: string,
  headers: Record<string, string> = {},
): Promise<McpTransport> {
  // Try streamable HTTP: a small probe POST
  try {
    const probe = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: "probe", method: "ping" }),
      signal: AbortSignal.timeout(5000),
    });

    await probe.text().catch(() => undefined);
    // 4xx (e.g. 405 Method Not Allowed) means the endpoint doesn't accept POST
    // at this URL — fall through to SSE probe.
    // 2xx or 5xx means the server understood the POST (method not found, etc.),
    // i.e. it IS streamable HTTP.
    if (probe.status >= 200 && probe.status < 400) {
      return "http";
    }
    if (probe.status >= 500) {
      // Server error but it accepted POST — treat as HTTP
      return "http";
    }
    // 4xx — fall through to SSE
  } catch {
    // Network error — fall through to SSE probe
  }

  // Try SSE: a GET to /sse (or the URL itself) that returns text/event-stream
  const sseUrl = url.endsWith("/sse") ? url : `${url}/sse`;
  try {
    const probe = await fetch(sseUrl, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        ...headers,
      },
      signal: AbortSignal.timeout(5000),
    });
    const ct = probe.headers.get("content-type") ?? "";
    await probe.body?.cancel().catch(() => undefined);
    if (ct.includes("text/event-stream")) {
      return "sse";
    }
  } catch {
    // Fall through
  }

  // Default to http
  return "http";
}

/* ================================================ createTransport ======== */

/**
 * Build the appropriate McpTransportImpl from a config shape.
 * Does NOT perform the MCP initialize handshake — that is McpClient's job.
 */
export function createTransport(
  transport: McpTransport,
  opts: {
    url?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    authToken?: string;
    authHeader?: string;
  },
): McpTransportImpl {
  const headers: Record<string, string> = {};
  if (opts.authToken) {
    const headerName = opts.authHeader ?? "Authorization";
    headers[headerName] =
      headerName.toLowerCase() === "authorization"
        ? `Bearer ${opts.authToken}`
        : opts.authToken;
  }

  if (transport === "http") {
    if (!opts.url) throw new Error("HTTP transport requires a url");
    return new HttpTransport(opts.url, headers);
  }

  if (transport === "sse") {
    if (!opts.url) throw new Error("SSE transport requires a url");
    return new SseTransport(opts.url, headers);
  }

  // stdio
  if (!opts.command) throw new Error("stdio transport requires a command");
  return new StdioTransport(opts.command, opts.args ?? [], opts.env ?? {});
}

/* -------------------------------------------------- re-export types ----- */
export type { McpTransport } from "../../shared/types.ts";

/**
 * Small helper: validate a raw string is parseable RPC, for transport tests.
 */
export function tryParseRpc(raw: string): unknown {
  const result = parseRpcMessage(raw);
  return result.ok ? result.message : null;
}
