/**
 * MCP integration tests.
 *
 * Spins up real HTTP and stdio MCP servers, exercises the full stack:
 * protocol.ts → transport.ts → client.ts → manager.ts → mcp.ts tools.
 *
 * Run with:
 *   node --experimental-strip-types --test tests/integration/mcp.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as net from "node:net";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  rpcRequest,
  rpcNotification,
  rpcSuccess,
  rpcErrorResponse,
  parseRpcMessage,
  isRequest,
  isNotification,
  isSuccess,
  isRpcError,
  RPC_METHOD_NOT_FOUND,
} from "../../src/main/mcp/protocol.ts";
import {
  HttpTransport,
  SseTransport,
  StdioTransport,
  detectTransport,
} from "../../src/main/mcp/transport.ts";
import { McpClient } from "../../src/main/mcp/client.ts";
import { McpManager } from "../../src/main/mcp/manager.ts";
import { makeMcpTools } from "../../src/main/tools/mcp.ts";
import { AskBroker } from "../../src/main/tools/ask.ts";
import type { ToolContext } from "../../src/main/tools/registry.ts";
import type { McpServerConfig } from "../../src/shared/types.ts";

/* ================================================================= helpers */

/**
 * Real AskBroker plus a responder that approves every pending per-tool policy
 * prompt ("allow_once"), so legacy mcp_call tests exercise the gate without a
 * human in the loop.
 */
function makeAutoAllowBroker(): AskBroker {
  const broker = new AskBroker();
  const origAsk = broker.ask.bind(broker);
  broker.ask = (sessionId, payload) => {
    const handle = origAsk(sessionId, payload);
    // Auto-answer on the next microtask once the handler is awaiting.
    queueMicrotask(() => {
      // The mcp_call gate is the only caller here; resolve with allow.
      void broker.resolve(handle.requestId, ["allow_once"], sessionId);
    });
    return handle;
  };
  return broker;
}

const autoAllowBroker = makeAutoAllowBroker();


function getPort(server: http.Server): number {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  return addr.port;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
    srv.on("error", reject);
  });
}

/** Build a minimal ToolContext for tool tests. */
function makeCtx(): ToolContext {
  return {
    sessionId: "test",
    mode: "cowork",
    workingFolder: null,
    outputsDir: "/tmp",
    capabilities: { vision: "no", tools: true, streaming: false, reasoning: false },
    modelId: "test",
    providerId: "test",
    signal: AbortSignal.timeout(30_000),
    onProgress: () => undefined,
  };
}

/* ================================================================= MCP server factory */

interface TestServerOpts {
  /** Extra tools beyond "echo" */
  extraTools?: Array<{ name: string; description: string; inputSchema: unknown }>;
  /** If set, require this header value for Authorization */
  requireAuthHeader?: string;
  /** Custom header name to check (default: authorization) */
  requireAuthHeaderName?: string;
  /** Delay a specific method by ms (for timeout tests) */
  delayMethod?: string;
  delayMs?: number;
  /** If true, respond to SSE with text/event-stream on GET /sse, POST to / */
  sseMode?: boolean;
  /** Record received headers here */
  capturedHeaders?: Array<Record<string, string>>;
}

/** Build a simple MCP-over-HTTP server for testing. */
function createMcpServer(opts: TestServerOpts = {}): http.Server {
  const tools = [
    {
      name: "echo",
      description: "Echoes its input",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
    ...(opts.extraTools ?? []),
  ];

  const handleRpc = async (
    body: string,
    authHeader: string | undefined,
    customHeader: string | undefined,
  ): Promise<unknown> => {
    // Capture headers for auth tests
    if (opts.capturedHeaders !== undefined) {
      const captured: Record<string, string> = {};
      if (authHeader) captured["authorization"] = authHeader;
      if (customHeader) captured["x-custom-auth"] = customHeader;
      opts.capturedHeaders.push(captured);
    }

    // Auth check
    if (opts.requireAuthHeader) {
      const hdrName = (opts.requireAuthHeaderName ?? "authorization").toLowerCase();
      const received = hdrName === "authorization" ? authHeader : customHeader;
      if (received !== opts.requireAuthHeader) {
        return rpcErrorResponse(null, -32000, "Unauthorized");
      }
    }

    let msg: unknown;
    try {
      msg = JSON.parse(body);
    } catch {
      return rpcErrorResponse(null, -32700, "Parse error");
    }

    // Handle array batches (we just handle first for simplicity)
    const req = Array.isArray(msg) ? msg[0] : msg;
    const r = req as { jsonrpc: string; id?: unknown; method?: string; params?: unknown };

    if (!r || r.jsonrpc !== "2.0") {
      return rpcErrorResponse(null, -32600, "Invalid request");
    }

    // Notification: no id, no response needed (but return null so we can skip)
    if (r.id === undefined || r.id === null) {
      return null;
    }

    const id = r.id as string | number;

    if (opts.delayMethod && r.method === opts.delayMethod) {
      await new Promise((res) => setTimeout(res, opts.delayMs ?? 5000));
    }

    switch (r.method) {
      case "initialize":
        return rpcSuccess(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "test-server", version: "1.0" },
        });

      case "tools/list":
        return rpcSuccess(id, { tools });

      case "tools/call": {
        const params = r.params as { name?: string; arguments?: Record<string, unknown> };
        const toolName = params?.name;
        const args = params?.arguments ?? {};

        if (toolName === "echo") {
          return rpcSuccess(id, {
            content: [{ type: "text", text: `echo: ${args["text"] ?? ""}` }],
          });
        }
        if (toolName === "add") {
          const a = Number(args["a"] ?? 0);
          const b = Number(args["b"] ?? 0);
          return rpcSuccess(id, {
            content: [{ type: "text", text: String(a + b) }],
          });
        }
        if (toolName === "fail_tool") {
          return rpcSuccess(id, {
            content: [{ type: "text", text: "tool failed" }],
            isError: true,
          });
        }
        return rpcErrorResponse(id, RPC_METHOD_NOT_FOUND, `Unknown tool: ${toolName}`);
      }

      default:
        return rpcErrorResponse(id, RPC_METHOD_NOT_FOUND, `Unknown method: ${r.method}`);
    }
  };

  const server = http.createServer(async (req, res) => {
    const authHeader = req.headers["authorization"] as string | undefined;
    const customHeader = req.headers["x-custom-auth"] as string | undefined;

    if (opts.sseMode) {
      // SSE-mode server: GET /sse opens the stream, POST /rpc handles calls
      // POST to / is rejected (405) — this is what detectTransport probes
      if (req.method === "GET" && req.url === "/sse") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        // Send the POST endpoint as SSE event
        res.write("event: endpoint\ndata: /rpc\n\n");
        req.on("close", () => res.end());
        return;
      }

      if (req.method === "POST" && req.url === "/rpc") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const result = await handleRpc(body, authHeader, customHeader);
        if (result === null) {
          res.writeHead(204);
          res.end();
          return;
        }
        const json = JSON.stringify(result);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(json),
        });
        res.end(json);
        return;
      }

      // POST to / returns 405 — not a streamable-HTTP server
      res.writeHead(405);
      res.end("Method Not Allowed");
      return;
    }

    if (req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;

      const result = await handleRpc(body, authHeader, customHeader);
      if (result === null) {
        // Notification — no body
        res.writeHead(204);
        res.end();
        return;
      }

      const json = JSON.stringify(result);
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(json),
      });
      res.end(json);
      return;
    }

    res.writeHead(405);
    res.end("Method Not Allowed");
  });

  return server;
}

/** Minimal stdio MCP server script. Written to a temp file and spawned. */
const STDIO_SERVER_SCRIPT = `
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; }

  if (!msg || msg.jsonrpc !== "2.0") return;
  if (msg.id === undefined || msg.id === null) return; // notification, no response

  const id = msg.id;

  const respond = (result) => {
    const r = JSON.stringify({ jsonrpc: "2.0", id, result });
    process.stdout.write(r + "\\n");
  };

  const respondError = (code, message) => {
    const r = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
    process.stdout.write(r + "\\n");
  };

  switch (msg.method) {
    case "initialize":
      respond({
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "stdio-test", version: "1.0" },
      });
      break;
    case "tools/list":
      respond({
        tools: [
          { name: "greet", description: "Greet someone", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }
        ]
      });
      break;
    case "tools/call": {
      const toolName = msg.params?.name;
      const args = msg.params?.arguments ?? {};
      if (toolName === "greet") {
        respond({ content: [{ type: "text", text: \`Hello, \${args.name}!\` }] });
      } else {
        respondError(-32601, \`Unknown tool: \${toolName}\`);
      }
      break;
    }
    default:
      respondError(-32601, \`Unknown method: \${msg.method}\`);
  }
});
`;

/* ================================================================= tests */

/* --------------------------------------------------- protocol.ts tests -- */

describe("protocol.ts", () => {
  describe("rpcRequest", () => {
    it("builds a valid request", () => {
      const req = rpcRequest(1, "tools/list", { cursor: null });
      assert.equal(req.jsonrpc, "2.0");
      assert.equal(req.id, 1);
      assert.equal(req.method, "tools/list");
      assert.deepEqual(req.params, { cursor: null });
    });

    it("omits params when undefined", () => {
      const req = rpcRequest("abc", "ping");
      assert.equal("params" in req, false);
    });
  });

  describe("rpcNotification", () => {
    it("builds a notification with no id", () => {
      const n = rpcNotification("notifications/initialized");
      assert.equal(n.jsonrpc, "2.0");
      assert.equal(n.method, "notifications/initialized");
      assert.equal("id" in n, false);
    });
  });

  describe("parseRpcMessage", () => {
    it("parses a valid request", () => {
      const raw = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      const result = parseRpcMessage(raw);
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(isRequest(result.message), true);
    });

    it("parses a notification (no id)", () => {
      const raw = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
      const result = parseRpcMessage(raw);
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(isNotification(result.message), true);
    });

    it("parses a success response", () => {
      const raw = JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
      const result = parseRpcMessage(raw);
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(isSuccess(result.message), true);
    });

    it("parses an error response", () => {
      const raw = JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        error: { code: -32601, message: "Method not found" },
      });
      const result = parseRpcMessage(raw);
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(isRpcError(result.message), true);
    });

    it("returns error for malformed JSON", () => {
      const result = parseRpcMessage("not json");
      assert.equal(result.ok, false);
    });

    it("returns error for wrong jsonrpc version", () => {
      const result = parseRpcMessage(JSON.stringify({ jsonrpc: "1.0", id: 1, method: "test" }));
      assert.equal(result.ok, false);
    });

    it("parses error response with null id", () => {
      const raw = JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      const result = parseRpcMessage(raw);
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(isRpcError(result.message), true);
    });
  });

  describe("rpcSuccess / rpcErrorResponse", () => {
    it("builds success response", () => {
      const r = rpcSuccess(5, { data: 42 });
      assert.equal(r.id, 5);
      assert.deepEqual(r.result, { data: 42 });
    });

    it("builds error response", () => {
      const r = rpcErrorResponse(5, -32000, "server error", { detail: "oops" });
      assert.equal(r.error.code, -32000);
      assert.equal(r.error.message, "server error");
      assert.deepEqual(r.error.data, { detail: "oops" });
    });
  });
});

/* ---------------------------------------------- HTTP transport tests ---- */

describe("HttpTransport", () => {
  let server: http.Server;
  let url: string;

  before(async () => {
    server = createMcpServer();
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    url = `http://127.0.0.1:${getPort(server)}`;
  });

  after(async () => {
    await new Promise<void>((res) => server.close(() => res()));
  });

  it("full round-trip: initialize → tools/list → tools/call", async () => {
    const transport = new HttpTransport(url, {}, { allowLocal: true });
    const client = new McpClient(transport);

    await client.initialize();
    const tools = await client.listTools();
    assert.ok(tools.length >= 1, "should have at least one tool");

    const echoTool = tools.find((t) => t.name === "echo");
    assert.ok(echoTool, "echo tool should be present");

    const result = await client.callTool("echo", { text: "hello world" });
    assert.ok(result.content.length > 0);
    const text = result.content[0];
    assert.equal(text?.type, "text");
    assert.ok(String(text?.text).includes("hello world"), "echo should return input");

    await client.close();
  });

  it("two concurrent requests return out of order", async () => {
    const transport = new HttpTransport(url, {}, { allowLocal: true });
    const client = new McpClient(transport);
    await client.initialize();

    const [tools, echo] = await Promise.all([
      client.listTools(),
      client.callTool("echo", { text: "concurrent" }),
    ]);

    assert.ok(Array.isArray(tools));
    assert.ok(echo.content.length > 0);

    await client.close();
  });
});

/* --------------------------------------------- SSE transport tests ----- */

describe("SseTransport", () => {
  let server: http.Server;
  let baseUrl: string;

  before(async () => {
    server = createMcpServer({ sseMode: true });
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    baseUrl = `http://127.0.0.1:${getPort(server)}`;
  });

  after(async () => {
    await new Promise<void>((res) => server.close(() => res()));
  });

  it("full round-trip via SSE transport", async () => {
    const transport = new SseTransport(baseUrl, {}, { allowLocal: true });
    const client = new McpClient(transport);

    await client.initialize();
    const tools = await client.listTools();
    assert.ok(tools.length >= 1);

    const result = await client.callTool("echo", { text: "sse test" });
    const text = result.content[0];
    assert.ok(String(text?.text).includes("sse test"));

    await client.close();
  });
});

/* -------------------------------------------- stdio transport tests ---- */

describe("StdioTransport", () => {
  let scriptPath: string;
  let tmpDir: string;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "kozum-mcp-stdio-"));
    scriptPath = join(tmpDir, "stdio-server.mjs");
    await writeFile(scriptPath, STDIO_SERVER_SCRIPT, "utf8");
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("full round-trip: initialize → tools/list → tools/call", async () => {
    const transport = new StdioTransport("node", [scriptPath]);
    const client = new McpClient(transport);

    await client.initialize();
    const tools = await client.listTools();
    assert.ok(tools.length >= 1, "should expose at least one tool");

    const greetTool = tools.find((t) => t.name === "greet");
    assert.ok(greetTool, "greet tool should be present");

    const result = await client.callTool("greet", { name: "Alice" });
    const text = result.content[0];
    assert.ok(String(text?.text).includes("Alice"), "greet should include name");

    await client.close();
  });

  it("process is reaped after close", async () => {
    const transport = new StdioTransport("node", [scriptPath]);
    const client = new McpClient(transport);
    await client.initialize();
    await client.close();

    // After close, the process should exit
    const exitCode = await transport.waitForExit();
    assert.ok(exitCode !== undefined, "process should have exited");
  });
});

/* ---------------------------------------- detectTransport tests -------- */

describe("detectTransport", () => {
  let httpServer: http.Server;
  let sseServer: http.Server;
  let httpUrl: string;
  let sseBaseUrl: string;

  before(async () => {
    httpServer = createMcpServer();
    await new Promise<void>((res) => httpServer.listen(0, "127.0.0.1", res));
    httpUrl = `http://127.0.0.1:${getPort(httpServer)}`;

    sseServer = createMcpServer({ sseMode: true });
    await new Promise<void>((res) => sseServer.listen(0, "127.0.0.1", res));
    sseBaseUrl = `http://127.0.0.1:${getPort(sseServer)}`;
  });

  after(async () => {
    await new Promise<void>((res) => httpServer.close(() => res()));
    await new Promise<void>((res) => sseServer.close(() => res()));
  });

  it("detects streamable HTTP for a POST-capable server", async () => {
    const transport = await detectTransport(httpUrl, {}, { allowLocal: true });
    assert.equal(transport, "http");
  });

  it("falls back to SSE for an SSE-only server", async () => {
    // SSE server returns 405 for POST to /
    const transport = await detectTransport(sseBaseUrl, {}, { allowLocal: true });
    assert.equal(transport, "sse");
  });
});

/* ----------------------------------------------- auth token tests ------ */

describe("auth token forwarding", () => {
  it("sends Authorization: Bearer <token>", async () => {
    const captured: Array<Record<string, string>> = [];
    const server = createMcpServer({
      requireAuthHeader: "Bearer secret123",
      capturedHeaders: captured,
    });
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    const url = `http://127.0.0.1:${getPort(server)}`;

    try {
      const transport = new HttpTransport(url, { Authorization: "Bearer secret123" }, { allowLocal: true });
      const client = new McpClient(transport);
      await client.initialize();
      await client.close();

      // Check captured headers
      const found = captured.some((h) => h["authorization"] === "Bearer secret123");
      assert.ok(found, "server should have received Authorization: Bearer secret123");
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  it("sends a custom header name when authHeader is given", async () => {
    const captured: Array<Record<string, string>> = [];
    const server = createMcpServer({
      requireAuthHeader: "mytoken",
      requireAuthHeaderName: "x-custom-auth",
      capturedHeaders: captured,
    });
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    const url = `http://127.0.0.1:${getPort(server)}`;

    try {
      const transport = new HttpTransport(url, { "x-custom-auth": "mytoken" }, { allowLocal: true });
      const client = new McpClient(transport);
      await client.initialize();
      await client.close();

      const found = captured.some((h) => h["x-custom-auth"] === "mytoken");
      assert.ok(found, "server should have received x-custom-auth: mytoken");
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  it("mcp_install sends auth token via manager → transport", async () => {
    const captured: Array<Record<string, string>> = [];
    const server = createMcpServer({
      requireAuthHeader: "Bearer install-token",
      capturedHeaders: captured,
    });
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    const url = `http://127.0.0.1:${getPort(server)}`;

    try {
      const manager = new McpManager();
      const tools = makeMcpTools(manager, autoAllowBroker);
      const installTool = tools.find((t) => t.definition.name === "mcp_install");
      assert.ok(installTool);

      const result = await installTool!.handler(
        { name: "auth-server", url, authToken: "install-token", transport: "http", allowLocal: true },
        makeCtx(),
      );
      assert.equal(result.ok, true, `Install failed: ${result.error ?? ""}`);

      const found = captured.some((h) => h["authorization"] === "Bearer install-token");
      assert.ok(found, "server should have received Authorization: Bearer install-token");
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });
});

/* --------------------------------------- request timeout tests ---------- */

describe("request timeout", () => {
  it("times out cleanly and does not hang", async () => {
    const server = createMcpServer({ delayMethod: "tools/list", delayMs: 3000 });
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    const url = `http://127.0.0.1:${getPort(server)}`;

    try {
      const transport = new HttpTransport(url, {}, { allowLocal: true });
      // Use a very short timeout
      const client = new McpClient(transport, 500);

      // initialize should succeed (no delay on that)
      await client.initialize();

      // tools/list should time out
      await assert.rejects(
        () => client.listTools(),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes("timed out"), `Expected timeout, got: ${err.message}`);
          return true;
        },
      );

      await client.close();
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });
});

/* ------------------------------------ JSON-RPC error response tests ----- */

describe("JSON-RPC error response handling", () => {
  it("error response becomes a failed ToolResult carrying the server message", async () => {
    const server = createMcpServer();
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    const url = `http://127.0.0.1:${getPort(server)}`;

    try {
      const manager = new McpManager();
      const tools = makeMcpTools(manager, autoAllowBroker);
      const installTool = tools.find((t) => t.definition.name === "mcp_install");
      assert.ok(installTool);

      await installTool!.handler({ name: "err-server", url, transport: "http", allowLocal: true }, makeCtx());

      const servers = manager.status();
      const srv = servers[0];
      assert.ok(srv, "server should be registered");

      // Call a tool that doesn't exist → RPC error from server
      const callResult = await manager.callTool(srv!.id, "nonexistent_tool", {});
      assert.equal(callResult.isError, true);
      assert.ok(
        callResult.content.includes("nonexistent_tool") ||
        callResult.content.includes("Unknown") ||
        callResult.content.includes("RPC error"),
        `Expected error message about tool, got: ${callResult.content}`,
      );
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  it("isError=true tool result surfaces as failed", async () => {
    const server = createMcpServer({
      extraTools: [{ name: "fail_tool", description: "always fails", inputSchema: {} }],
    });
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    const url = `http://127.0.0.1:${getPort(server)}`;

    try {
      const manager = new McpManager();
      const config: McpServerConfig = {
        id: "fail-srv",
        name: "fail-srv",
        enabled: true,
        transport: "http",
        url,
        hasAuthToken: false,
        createdAt: Date.now(),
        installedByAgent: false,
        status: "disconnected",
        toolCount: 0,
        allowLocal: true,
      };
      await manager.add(config);
      await manager.connect("fail-srv");

      const result = await manager.callTool("fail-srv", "fail_tool", {});
      assert.equal(result.isError, true);
      assert.ok(result.content.includes("tool failed"));
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });
});

/* --------------------------------- mcp_install end-to-end tests --------- */

describe("mcp_install end-to-end", () => {
  let server: http.Server;
  let url: string;

  before(async () => {
    server = createMcpServer({
      extraTools: [
        {
          name: "add",
          description: "Add two numbers",
          inputSchema: {
            type: "object",
            properties: {
              a: { type: "number" },
              b: { type: "number" },
            },
            required: ["a", "b"],
          },
        },
      ],
    });
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    url = `http://127.0.0.1:${getPort(server)}`;
  });

  after(async () => {
    await new Promise<void>((res) => server.close(() => res()));
  });

  it("testConnection performs a real handshake without registering the server", async () => {
    const manager = new McpManager();
    const result = await manager.testConnection({
      transport: "http",
      url,
      allowLocal: true,
    });
    assert.equal(result.transport, "http");
    assert.ok(result.toolCount >= 2);
    assert.ok(result.toolNames.includes("echo"));
    assert.equal(manager.status().length, 0, "testConnection must not persist a server");
  });

  it("testConnection refuses a localhost endpoint unless explicitly allowed", async () => {
    const manager = new McpManager();
    await assert.rejects(
      () => manager.testConnection({ transport: "http", url, allowLocal: false }),
      /SSRF guard/i,
    );
  });

  it("install → new tools appear in allTools() → mcp_call succeeds", async () => {
    const manager = new McpManager();
    const tools = makeMcpTools(manager, autoAllowBroker);

    const installTool = tools.find((t) => t.definition.name === "mcp_install");
    const callTool = tools.find((t) => t.definition.name === "mcp_call");
    const listTool = tools.find((t) => t.definition.name === "mcp_list");
    assert.ok(installTool && callTool && listTool);

    // Install the server
    const installResult = await installTool!.handler(
      { name: "math", url, transport: "http", allowLocal: true },
      makeCtx(),
    );
    assert.equal(installResult.ok, true, `Install failed: ${installResult.error ?? ""}`);

    // Check allTools()
    const allTools = manager.allTools();
    const namespacedEcho = allTools.find((t) => t.name === "mcp__math__echo");
    const namespacedAdd = allTools.find((t) => t.name === "mcp__math__add");
    assert.ok(namespacedEcho, "mcp__math__echo should be in allTools");
    assert.ok(namespacedAdd, "mcp__math__add should be in allTools");

    // Use mcp_call to invoke 'add'
    const servers = manager.status();
    const srv = servers[0];
    assert.ok(srv);

    const callResult = await callTool!.handler(
      { serverId: srv!.id, tool: "add", args: { a: 7, b: 8 } },
      makeCtx(),
    );
    assert.equal(callResult.ok, true, `mcp_call failed: ${callResult.error ?? ""}`);
    assert.ok(callResult.content.includes("15"), "add(7,8) should be 15");

    // List also works
    const listResult = await listTool!.handler({}, makeCtx());
    assert.equal(listResult.ok, true);
    assert.ok(listResult.content.includes("math"));
  });

  it("mcp_remove cleans up", async () => {
    const manager = new McpManager();
    const tools = makeMcpTools(manager, autoAllowBroker);
    const installTool = tools.find((t) => t.definition.name === "mcp_install")!;
    const removeTool = tools.find((t) => t.definition.name === "mcp_remove")!;

    await installTool.handler({ name: "to-remove", url, transport: "http", allowLocal: true }, makeCtx());
    const servers = manager.status();
    assert.equal(servers.length, 1);

    const removeResult = await removeTool.handler(
      { id: servers[0]!.id },
      makeCtx(),
    );
    assert.equal(removeResult.ok, true);
    assert.equal(manager.status().length, 0);
  });
});

/* --------------------------------- unhealthy server isolation tests ----- */

describe("server isolation", () => {
  it("a refused connection does not prevent a second healthy server from working", async () => {
    const goodServer = createMcpServer();
    await new Promise<void>((res) => goodServer.listen(0, "127.0.0.1", res));
    const goodUrl = `http://127.0.0.1:${getPort(goodServer)}`;

    // A port with nothing listening
    const deadPort = await freePort();
    const deadUrl = `http://127.0.0.1:${deadPort}`;

    try {
      const manager = new McpManager();

      const deadConfig: McpServerConfig = {
        id: "dead",
        name: "dead",
        enabled: true,
        transport: "http",
        url: deadUrl,
        hasAuthToken: false,
        createdAt: Date.now(),
        installedByAgent: false,
        status: "disconnected",
        toolCount: 0,
        allowLocal: true,
      };
      const goodConfig: McpServerConfig = {
        id: "good",
        name: "good",
        enabled: true,
        transport: "http",
        url: goodUrl,
        hasAuthToken: false,
        createdAt: Date.now(),
        installedByAgent: false,
        status: "disconnected",
        toolCount: 0,
        allowLocal: true,
      };

      await manager.add(deadConfig);
      await manager.add(goodConfig);
      await manager.connectAll();

      const statuses = manager.status();
      const dead = statuses.find((s) => s.id === "dead");
      const good = statuses.find((s) => s.id === "good");

      assert.equal(dead?.status, "error", "dead server should be in error state");
      assert.equal(good?.status, "connected", "good server should be connected");

      // Tools from good server are still accessible
      const allTools = manager.allTools();
      const goodTools = allTools.filter((t) => t.serverId === "good");
      assert.ok(goodTools.length > 0, "good server's tools should be listed");
    } finally {
      await new Promise<void>((res) => goodServer.close(() => res()));
    }
  });
});

/* ------------------------------------- tool namespacing tests ----------- */

describe("tool namespacing", () => {
  it("namespaces tools as mcp__serverName__toolName", async () => {
    const server = createMcpServer({
      extraTools: [
        { name: "add", description: "add", inputSchema: {} },
      ],
    });
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    const url = `http://127.0.0.1:${getPort(server)}`;

    try {
      const manager = new McpManager();
      const config: McpServerConfig = {
        id: "ns-test",
        name: "myserver",
        enabled: true,
        transport: "http",
        url,
        hasAuthToken: false,
        createdAt: Date.now(),
        installedByAgent: false,
        status: "disconnected",
        toolCount: 0,
        allowLocal: true,
      };
      await manager.add(config);
      await manager.connect("ns-test");

      const allTools = manager.allTools();
      for (const tool of allTools) {
        assert.ok(
          tool.name.startsWith("mcp__myserver__"),
          `Expected tool name to start with mcp__myserver__, got: ${tool.name}`,
        );
      }
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });
});

/* --------------------------------- concurrent in-flight correlation ----- */

describe("concurrent request correlation", () => {
  it("two in-flight calls with out-of-order responses correlate correctly", async () => {
    // Build a server that deliberately delays 'echo' but not 'tools/list'
    // so they return out of order
    const delayServer = createMcpServer({ delayMethod: "tools/call", delayMs: 100 });
    await new Promise<void>((res) => delayServer.listen(0, "127.0.0.1", res));
    const url = `http://127.0.0.1:${getPort(delayServer)}`;

    try {
      const transport = new HttpTransport(url, {}, { allowLocal: true });
      const client = new McpClient(transport);
      await client.initialize();

      // Fire both requests; tools/list should finish first
      const [listResult, callResult] = await Promise.all([
        client.listTools(),
        client.callTool("echo", { text: "out-of-order" }),
      ]);

      assert.ok(Array.isArray(listResult), "listTools should return array");
      assert.ok(callResult.content.length > 0);
      const callText = callResult.content[0];
      assert.ok(String(callText?.text).includes("out-of-order"));

      await client.close();
    } finally {
      await new Promise<void>((res) => delayServer.close(() => res()));
    }
  });
});

/* ---------------------------------- mcp_install failure / rollback ----- */

describe("mcp_install failure handling", () => {
  it("removes half-added server on connection failure", async () => {
    const deadPort = await freePort();
    const deadUrl = `http://127.0.0.1:${deadPort}`;

    const manager = new McpManager();
    const tools = makeMcpTools(manager, autoAllowBroker);
    const installTool = tools.find((t) => t.definition.name === "mcp_install")!;

    const result = await installTool.handler(
      { name: "dead-server", url: deadUrl, transport: "http", allowLocal: true },
      makeCtx(),
    );

    assert.equal(result.ok, false, "install should fail");
    assert.ok(result.error?.includes("dead-server") || result.error?.length, "error should describe failure");

    // Server should be cleaned up
    assert.equal(manager.status().length, 0, "failed server should not remain registered");
  });
});
