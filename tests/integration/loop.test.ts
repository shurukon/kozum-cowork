/**
 * Agent loop — end-to-end integration.
 *
 * The loop is exercised through the *real* OpenAI adapter, over a *real* HTTP
 * server speaking *real* SSE, executing *real* tools that touch a *real*
 * temp directory. Nothing in the path under test is stubbed.
 *
 * The server is scripted per-request, which is how we drive multi-round
 * behaviour: round 1 asks for a tool, round 2 sees the result and answers.
 */

import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { runAgentLoop, type ToolExecutor } from "../../src/main/agent/loop.ts";
import { OpenAiChatAdapter } from "../../src/main/providers/adapters/openai-chat.ts";
import type { AgentEvent, Message, ToolDefinition, ToolResult } from "../../src/shared/types.ts";

/* ----------------------------------------------------------- test rig --- */

/** Each entry is the full SSE body for one successive request. */
let script: string[] = [];
let requests: any[] = [];
let server: http.Server;
let base = "";
let workDir = "";

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const done = "data: [DONE]\n\n";

const sayText = (t: string) =>
  sse({ choices: [{ delta: { content: t } }] }) +
  sse({ choices: [{ delta: {}, finish_reason: "stop" }] }) +
  done;

const callTool = (id: string, name: string, args: unknown) =>
  sse({
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id, function: { name, arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
  }) +
  sse({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) +
  done;

before(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      requests.push(raw ? JSON.parse(raw) : null);
      const body = script[requests.length - 1] ?? sayText("(script exhausted)");
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

beforeEach(async () => {
  script = [];
  requests = [];
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = await mkdtemp(join(tmpdir(), "kozum-loop-"));
});

/* ------------------------------------------------- a real tool executor -- */

const DEFS: ToolDefinition[] = [
  {
    name: "file_read",
    title: "File read",
    description: "Read a UTF-8 file.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "File path" } },
      required: ["path"],
    },
    icon: "file-text",
    group: "filesystem",
    modes: ["cowork", "code"],
  },
  {
    name: "file_write",
    title: "File write",
    description: "Write a UTF-8 file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        content: { type: "string", description: "Contents" },
      },
      required: ["path", "content"],
    },
    icon: "file-plus",
    group: "filesystem",
    modes: ["cowork", "code"],
  },
  {
    name: "explode",
    title: "Explode",
    description: "Always throws, to prove the loop survives a broken tool.",
    inputSchema: { type: "object", properties: {} },
    icon: "bug",
    group: "system",
    modes: ["cowork", "code"],
  },
];

const executor: ToolExecutor = {
  list: () => DEFS,
  async execute(name, input): Promise<ToolResult> {
    const arg = (input ?? {}) as Record<string, string>;
    if (name === "file_read") {
      const text = await readFile(join(workDir, arg.path), "utf8");
      return { ok: true, content: text, display: { summary: `Read ${arg.path}` } };
    }
    if (name === "file_write") {
      await writeFile(join(workDir, arg.path), arg.content, "utf8");
      return { ok: true, content: `wrote ${arg.content.length} bytes`, display: { summary: `Wrote ${arg.path}` } };
    }
    if (name === "explode") throw new Error("boom");
    return { ok: false, content: "", error: `unknown tool ${name}` };
  },
};

function userTurn(text: string): Message[] {
  return [{ id: "u1", role: "user", content: [{ type: "text", text }], createdAt: 0 }];
}

async function run(
  history: Message[],
  opts: { maxIterations?: number; signal?: AbortSignal } = {},
) {
  const events: AgentEvent[] = [];
  const result = await runAgentLoop({
    sessionId: "s1",
    mode: "cowork",
    adapter: new OpenAiChatAdapter(),
    ctx: { providerId: "test", baseUrl: base, apiKey: "k", meta: {}, extraHeaders: {} },
    model: "test-model",
    system: "sys",
    history,
    tools: executor,
    maxTokens: 256,
    temperature: 0,
    maxIterations: opts.maxIterations ?? 8,
    signal: opts.signal ?? new AbortController().signal,
    emit: (e) => events.push(e),
  });
  return { result, events };
}

/* ------------------------------------------------------------- tests ---- */

describe("single round", () => {
  it("returns plain text with no tools", async () => {
    script = [sayText("All done.")];
    const { result, events } = await run(userTurn("hello"));

    assert.equal(result.iterations, 1);
    assert.equal(result.stopReason, "end_turn");
    assert.equal(result.messages.length, 1);
    const text = result.messages[0].content.find((b) => b.type === "text");
    assert.equal((text as any).text, "All done.");
    assert.ok(events.some((e) => e.type === "turn_start"));
    assert.ok(events.some((e) => e.type === "turn_end"));
  });
});

describe("tool round-trip", () => {
  it("executes a tool and feeds the result back for a second round", async () => {
    await writeFile(join(workDir, "notes.txt"), "hello from disk", "utf8");
    script = [
      callTool("c1", "file_read", { path: "notes.txt" }),
      sayText("The file says: hello from disk"),
    ];

    const { result, events } = await run(userTurn("read notes.txt"));

    assert.equal(result.iterations, 2, "one tool round plus the answer");
    assert.equal(result.stopReason, "end_turn");

    // The tool actually ran against the real filesystem.
    const toolEnd = events.find((e) => e.type === "tool_end") as any;
    assert.equal(toolEnd.result.ok, true);
    assert.equal(toolEnd.result.content, "hello from disk");

    // Round 2 must have carried the tool result back to the provider.
    const second = requests[1];
    const toolMsg = second.messages.find((m: any) => m.role === "tool");
    assert.ok(toolMsg, "second request includes a tool-role message");
    assert.equal(toolMsg.tool_call_id, "c1");
    assert.equal(toolMsg.content, "hello from disk");
  });

  it("actually writes files the model asks for", async () => {
    script = [
      callTool("c1", "file_write", { path: "out.md", content: "# Kozum" }),
      sayText("Written."),
    ];
    await run(userTurn("make out.md"));

    const written = await readFile(join(workDir, "out.md"), "utf8");
    assert.equal(written, "# Kozum", "the file exists on disk with the right bytes");
  });
});

describe("resilience", () => {
  it("survives a tool that throws and reports it to the model", async () => {
    script = [callTool("c1", "explode", {}), sayText("I saw the error.")];
    const { result, events } = await run(userTurn("break it"));

    const end = events.find((e) => e.type === "tool_end") as any;
    assert.equal(end.result.ok, false);
    assert.match(end.result.error, /boom/);

    // The loop kept going rather than dying.
    assert.equal(result.iterations, 2);
    assert.equal(result.stopReason, "end_turn");

    // And the model was told, via a tool-role message flagged as an error.
    const toolMsg = requests[1].messages.find((m: any) => m.role === "tool");
    assert.match(toolMsg.content, /boom/);
  });

  it("turns malformed tool JSON into a correctable error, not a crash", async () => {
    script = [
      sse({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "c1", function: { name: "file_read", arguments: '{"path": ' } },
              ],
            },
          },
        ],
      }) + sse({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) + done,
      sayText("Retrying properly."),
    ];

    const { result, events } = await run(userTurn("read something"));
    const end = events.find((e) => e.type === "tool_end") as any;
    assert.equal(end.result.ok, false);
    assert.match(end.result.error, /valid JSON/i);
    assert.equal(result.stopReason, "end_turn");
  });

  it("stops at the iteration ceiling instead of looping forever", async () => {
    // A model that only ever asks for tools.
    script = Array.from({ length: 10 }, (_, i) =>
      callTool(`c${i}`, "file_write", { path: `f${i}.txt`, content: "x" }),
    );

    const { result, events } = await run(userTurn("loop"), { maxIterations: 3 });

    assert.equal(result.iterations, 3);
    const errs = events.filter((e) => e.type === "error") as any[];
    assert.ok(errs.length, "emits an explanatory error");
    assert.match(errs[0].message, /3 tool rounds/);
  });
});

describe("cancellation", () => {
  it("leaves a replayable transcript when aborted mid-turn", async () => {
    // Abort as soon as the tool call has been requested.
    const ctrl = new AbortController();
    script = [callTool("c1", "file_read", { path: "nope.txt" }), sayText("unused")];

    // Abort once the first response has been consumed.
    const original = executor.execute;
    (executor as any).execute = async (...args: any[]) => {
      ctrl.abort();
      return (original as any).apply(executor, args);
    };

    const { result } = await run(userTurn("go"), { signal: ctrl.signal });
    (executor as any).execute = original;

    // Every tool_use in the transcript must have a matching tool_result,
    // otherwise the next provider call would 400 on an unanswered call.
    const uses = new Set<string>();
    const answers = new Set<string>();
    for (const m of result.messages) {
      for (const b of m.content) {
        if (b.type === "tool_use") uses.add(b.id);
        if (b.type === "tool_result") answers.add(b.toolUseId);
      }
    }
    for (const id of uses) {
      assert.ok(answers.has(id), `tool_use ${id} must have a tool_result after cancellation`);
    }
  });
});

describe("accounting", () => {
  it("sums usage across every round of the turn", async () => {
    const withUsage = (t: string, i: number, o: number) =>
      sse({ choices: [{ delta: { content: t } }] }) +
      sse({
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: i, completion_tokens: o },
      }) +
      done;

    const toolWithUsage =
      sse({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "c1", function: { name: "file_write", arguments: '{"path":"a","content":"b"}' } },
              ],
            },
          },
        ],
      }) +
      sse({
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }) +
      done;

    script = [toolWithUsage, withUsage("done", 150, 10)];
    const { result } = await run(userTurn("go"));

    assert.equal(result.usage.inputTokens, 250);
    assert.equal(result.usage.outputTokens, 30);
  });
});
