import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McpManager } from "../src/main/mcp/manager.ts";
import { makeMcpTools } from "../src/main/tools/mcp.ts";
import { runAgentLoop } from "../src/main/agent/loop.ts";
import { OpenAiChatAdapter } from "../src/main/providers/adapters/openai-chat.ts";

const sse = (value) => `data: ${JSON.stringify(value)}\n\n`;
const done = "data: [DONE]\n\n";
const callTool = (id, name, args) => sse({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] }) + sse({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) + done;
const sayText = (text) => sse({ choices: [{ delta: { content: text } }] }) + sse({ choices: [{ delta: {}, finish_reason: "stop" }] }) + done;

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(text)) });
  res.end(text);
}
function rpc(id, result) { return { jsonrpc: "2.0", id, result }; }

const root = await mkdtemp(join(tmpdir(), "kozum-mcp-agent-live-"));
const reportPath = process.env.KOZUM_MCP_AGENT_REPORT ?? join(process.cwd(), "artifacts", "mcp-agent-live.json");
const mcpRequests = [];
const providerRequests = [];
const mcpServer = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  mcpRequests.push(message.method ?? "notification");
  if (!message.id) { res.writeHead(202); res.end(); return; }
  if (message.method === "initialize") return json(res, 200, rpc(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "agent-proof", version: "1" } }));
  if (message.method === "tools/list") return json(res, 200, rpc(message.id, { tools: [{ name: "add", description: "Add two numbers", inputSchema: { type: "object" } }] }));
  if (message.method === "tools/call" && message.params?.name === "add") {
    const args = message.params.arguments ?? {};
    return json(res, 200, rpc(message.id, { content: [{ type: "text", text: String(Number(args.a ?? 0) + Number(args.b ?? 0)) }] }));
  }
  return json(res, 200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown method" } });
});
let providerTurn = 0;
const providerServer = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  providerRequests.push({ messageCount: Array.isArray(body.messages) ? body.messages.length : 0, hasToolResult: Array.isArray(body.messages) && body.messages.some((message) => message?.role === "tool") });
  providerTurn += 1;
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(providerTurn === 1 ? callTool("call_mcp_add", "mcp_call", { serverId: process.env.KOZUM_MCP_AGENT_SERVER_ID, tool: "add", args: { a: 19, b: 23 } }) : sayText("The MCP tool returned 42 and the agent completed the task."));
});

try {
  await new Promise((resolve, reject) => { mcpServer.once("error", reject); mcpServer.listen(0, "127.0.0.1", resolve); });
  await new Promise((resolve, reject) => { providerServer.once("error", reject); providerServer.listen(0, "127.0.0.1", resolve); });
  const mcpUrl = `http://127.0.0.1:${mcpServer.address().port}`;
  const providerUrl = `http://127.0.0.1:${providerServer.address().port}`;
  const manager = new McpManager(join(root, "mcp.json"));
  const mcpTools = makeMcpTools(manager);
  const install = mcpTools.find((tool) => tool.definition.name === "mcp_install");
  if (!install) throw new Error("mcp_install is not registered");
  const toolContext = {
    sessionId: "mcp-agent-proof",
    mode: "cowork",
    workingFolder: root,
    outputsDir: root,
    capabilities: { vision: "yes", tools: true, streaming: true, reasoning: false },
    modelId: "proof-model",
    providerId: "proof-provider",
    signal: new AbortController().signal,
    onProgress: () => {},
  };
  const installResult = await install.handler({ name: "agent-proof", url: mcpUrl, transport: "http", allowLocal: true }, toolContext);
  if (!installResult.ok) throw new Error(`mcp_install failed: ${installResult.error}`);
  const serverRecord = manager.status().find((entry) => entry.name === "agent-proof");
  if (!serverRecord) throw new Error("MCP server was not registered");
  process.env.KOZUM_MCP_AGENT_SERVER_ID = serverRecord.id;

  const executor = {
    list: () => mcpTools.map((tool) => tool.definition),
    execute: async (name, input, ctx) => {
      const tool = mcpTools.find((candidate) => candidate.definition.name === name);
      return tool ? tool.handler(input, ctx) : { ok: false, content: "unknown tool", error: "unknown tool" };
    },
  };
  const events = [];
  const result = await runAgentLoop({
    sessionId: "mcp-agent-proof",
    mode: "cowork",
    adapter: new OpenAiChatAdapter(),
    ctx: { providerId: "proof-provider", baseUrl: providerUrl, apiKey: "not-a-secret", meta: {}, extraHeaders: {} },
    model: "proof-model",
    system: "Use the available MCP tool when the task requires arithmetic.",
    history: [{ id: "user-proof", role: "user", content: [{ type: "text", text: "Use MCP to add 19 and 23." }], createdAt: Date.now() }],
    tools: executor,
    maxTokens: 256,
    temperature: 0,
    maxIterations: 4,
    signal: new AbortController().signal,
    emit: (event) => events.push(event),
  });
  const toolEnd = events.find((event) => event.type === "tool_end");
  const report = {
    ok: result.stopReason === "end_turn" && toolEnd?.type === "tool_end" && toolEnd.result.ok === true,
    mcpServer: { name: serverRecord.name, status: manager.status().find((entry) => entry.id === serverRecord.id)?.status, tools: manager.allTools().map((tool) => tool.name) },
    agentLoop: { stopReason: result.stopReason, iterations: result.iterations, toolEvents: events.filter((event) => event.type === "tool_start" || event.type === "tool_end").map((event) => event.type === "tool_end" ? { type: event.type, ok: event.result.ok, content: event.result.content } : { type: event.type, name: event.name }) },
    mcpRpcMethodsSeen: mcpRequests,
    providerTurns: providerRequests,
    finalText: result.messages.flatMap((message) => message.content).filter((block) => block.type === "text").map((block) => block.text).join(" "),
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  if (!report.ok) throw new Error(`agent MCP proof failed: ${JSON.stringify(report)}`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await new Promise((resolve) => providerServer.close(() => resolve()));
  await new Promise((resolve) => mcpServer.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
