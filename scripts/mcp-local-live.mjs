import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McpManager } from "../src/main/mcp/manager.ts";
import { makeMcpTools } from "../src/main/tools/mcp.ts";

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(text)),
  });
  res.end(text);
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

const methodsSeen = [];
const server = createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405);
    res.end();
    return;
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let message;
  try {
    message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    json(res, 400, rpcError(null, -32700, "Invalid JSON"));
    return;
  }

  methodsSeen.push(message.method ?? "<notification>");
  if (!message.id) {
    res.writeHead(202);
    res.end();
    return;
  }

  if (message.method === "initialize") {
    json(res, 200, rpcResult(message.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "kozum-local-proof", version: "1.0.0" },
    }));
    return;
  }

  if (message.method === "tools/list") {
    json(res, 200, rpcResult(message.id, {
      tools: [
        {
          name: "echo",
          description: "Return the supplied text.",
          inputSchema: { type: "object", properties: { text: { type: "string" } } },
        },
        {
          name: "add",
          description: "Add two numbers.",
          inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
        },
      ],
    }));
    return;
  }

  if (message.method === "tools/call") {
    const name = message.params?.name;
    const args = message.params?.arguments ?? {};
    if (name === "echo") {
      json(res, 200, rpcResult(message.id, {
        content: [{ type: "text", text: `echo:${String(args.text ?? "")}` }],
      }));
      return;
    }
    if (name === "add") {
      json(res, 200, rpcResult(message.id, {
        content: [{ type: "text", text: String(Number(args.a ?? 0) + Number(args.b ?? 0)) }],
      }));
      return;
    }
    json(res, 200, rpcError(message.id, -32601, `Unknown tool ${String(name)}`));
    return;
  }

  json(res, 200, rpcError(message.id, -32601, `Unknown method ${String(message.method)}`));
});

const root = await mkdtemp(join(tmpdir(), "kozum-mcp-live-"));
const reportPath = process.env.KOZUM_MCP_REPORT ?? join(process.cwd(), "artifacts", "mcp-local-live.json");

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;

  const manager = new McpManager(join(root, "mcp.json"));
  const tools = makeMcpTools(manager);
  const install = tools.find((tool) => tool.definition.name === "mcp_install");
  const call = tools.find((tool) => tool.definition.name === "mcp_call");
  if (!install || !call) throw new Error("MCP tools were not registered");

  const ctx = {
    sessionId: "mcp-live-proof",
    mode: "cowork",
    workingFolder: root,
    outputsDir: root,
    capabilities: { vision: "yes", tools: true, streaming: true, reasoning: false },
    modelId: "mcp-live-proof",
    providerId: "local",
    signal: new AbortController().signal,
    onProgress: () => {},
  };

  const installResult = await install.handler(
    { name: "local-proof", url, transport: "http", allowLocal: true },
    ctx,
  );
  if (!installResult.ok) throw new Error(`mcp_install failed: ${installResult.error}`);

  const status = manager.status();
  const serverRecord = status.find((entry) => entry.name === "local-proof");
  if (!serverRecord) throw new Error("Installed MCP server was not listed");

  const discoveredTools = manager.allTools().filter((tool) => tool.serverId === serverRecord.id);
  const callResult = await call.handler(
    { serverId: serverRecord.id, tool: "add", args: { a: 19, b: 23 } },
    ctx,
  );
  if (!callResult.ok || !callResult.content.includes("42")) {
    throw new Error(`mcp_call failed: ${callResult.error ?? callResult.content}`);
  }

  const persisted = JSON.parse(await readFile(join(root, "mcp.json"), "utf8"));
  const report = {
    ok: true,
    endpoint: url,
    server: { id: serverRecord.id, name: serverRecord.name, status: serverRecord.status },
    discoveredTools: discoveredTools.map((tool) => tool.name),
    install: { ok: installResult.ok, content: installResult.content },
    call: { ok: callResult.ok, content: callResult.content },
    rpcMethodsSeen: methodsSeen,
    persistedServerCount: Array.isArray(persisted.servers) ? persisted.servers.length : 0,
    persistedHasRawAuthToken: JSON.stringify(persisted).includes("authToken"),
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await new Promise((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
