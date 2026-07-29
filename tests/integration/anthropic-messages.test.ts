/**
 * Anthropic Messages adapter — integration tests against a real HTTP server.
 *
 * Stands up an actual node:http server emitting real SSE bytes and drives the
 * real adapter over the real network stack. Follows the openai-chat.test.ts
 * pattern exactly.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { AnthropicMessagesAdapter } from "../../src/main/providers/adapters/anthropic-messages.ts";
import type { ProviderContext, StreamDelta } from "../../src/main/providers/adapter.ts";
import type { Message } from "../../src/shared/types.ts";

let chunks: (string | Buffer)[] = [];
let status = 200;
let lastBody: any = null;
let lastHeaders: Record<string, string | string[] | undefined> = {};

let server: http.Server;
let base = "";

before(async () => {
  server = http.createServer((req, res) => {
    lastHeaders = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k, v]),
    );
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      try {
        lastBody = raw ? JSON.parse(raw) : null;
      } catch {
        lastBody = raw;
      }

      if (req.url?.endsWith("/models")) {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(chunks.join(""));
        return;
      }

      if (status !== 200) {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(chunks.join(""));
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      for (const c of chunks) res.write(c);
      res.end();
    });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise<void>((r) => server.close(() => r())));

function ctx(): ProviderContext {
  return {
    providerId: "anthropic",
    baseUrl: base,
    apiKey: "test-key",
    meta: {},
    extraHeaders: {},
  };
}

function userMsg(text: string): Message {
  return {
    id: "m1",
    role: "user",
    content: [{ type: "text", text }],
    createdAt: Date.now(),
  };
}

async function collect(messages: Message[] = [userMsg("hi")]): Promise<StreamDelta[]> {
  const adapter = new AnthropicMessagesAdapter();
  const out: StreamDelta[] = [];
  for await (const d of adapter.stream(ctx(), {
    model: "claude-sonnet-4-6",
    system: "You are a test.",
    messages,
    tools: [],
    maxTokens: 128,
    temperature: 0,
    signal: new AbortController().signal,
  })) {
    out.push(d);
  }
  return out;
}

/* ----------------------------------------------------------- helpers --- */

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

const msgStart = (inputTokens = 10) =>
  sse({ type: "message_start", message: { usage: { input_tokens: inputTokens } } });
const blockStart = (index: number, blockType: "text" | "tool_use", extra: Record<string, unknown> = {}) =>
  sse({ type: "content_block_start", index, content_block: { type: blockType, ...extra } });
const blockDelta = (index: number, delta: Record<string, unknown>) =>
  sse({ type: "content_block_delta", index, delta });
const blockStop = (index: number) =>
  sse({ type: "content_block_stop", index });
const msgDelta = (stopReason: string, outputTokens = 5) =>
  sse({ type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: outputTokens } });
const msgStop = () => sse({ type: "message_stop" });

const textDelta = (index: number, text: string) =>
  blockDelta(index, { type: "text_delta", text });

/* ------------------------------------------------------------------------ */

describe("streaming text", () => {
  it("assembles simple text deltas in order", async () => {
    status = 200;
    chunks = [
      msgStart(),
      blockStart(0, "text"),
      textDelta(0, "Hello"),
      textDelta(0, ", "),
      textDelta(0, "world"),
      blockStop(0),
      msgDelta("end_turn"),
      msgStop(),
    ];

    const deltas = await collect();
    const text = deltas
      .filter((d) => d.type === "text")
      .map((d) => (d as any).text)
      .join("");

    assert.equal(text, "Hello, world");
    const stop = deltas.at(-1);
    assert.equal(stop?.type, "stop");
    assert.equal((stop as any).reason, "end_turn");
  });

  it("survives frames split across chunk boundaries", async () => {
    status = 200;
    const frame = textDelta(0, "split-me");
    chunks = [
      msgStart(),
      blockStart(0, "text"),
      frame.slice(0, 10),
      frame.slice(10, 25),
      frame.slice(25),
      blockStop(0),
      msgDelta("end_turn"),
    ];

    const deltas = await collect();
    const text = deltas
      .filter((d) => d.type === "text")
      .map((d) => (d as any).text)
      .join("");
    assert.equal(text, "split-me");
  });

  it("does not corrupt multi-byte UTF-8 split across chunks", async () => {
    status = 200;
    const arabic = "مرحبا بالعالم";
    const emoji = "🚀✅";
    const frame = Buffer.from(textDelta(0, arabic + emoji), "utf8");

    const cut = frame.indexOf(Buffer.from(arabic, "utf8")) + 5;
    chunks = [
      msgStart(),
      blockStart(0, "text"),
      frame.subarray(0, cut),
      frame.subarray(cut),
      blockStop(0),
      msgDelta("end_turn"),
    ];

    const deltas = await collect();
    const text = deltas
      .filter((d) => d.type === "text")
      .map((d) => (d as any).text)
      .join("");

    assert.equal(text, arabic + emoji, "multi-byte text must survive chunk splits");
    assert.ok(!text.includes("�"), "no replacement characters");
  });
});

describe("tool calls", () => {
  it("assembles a tool call from content_block events", async () => {
    status = 200;
    chunks = [
      msgStart(),
      blockStart(0, "tool_use", { id: "tu_1", name: "file_read" }),
      blockDelta(0, { type: "input_json_delta", partial_json: '{"pa' }),
      blockDelta(0, { type: "input_json_delta", partial_json: 'th":"a.txt"}' }),
      blockStop(0),
      msgDelta("tool_use"),
      msgStop(),
    ];

    const deltas = await collect();
    const start = deltas.find((d) => d.type === "tool_start");
    assert.ok(start, "emits tool_start");
    assert.equal((start as any).name, "file_read");
    assert.equal((start as any).id, "tu_1");

    const args = deltas
      .filter((d) => d.type === "tool_args")
      .map((d) => (d as any).partial)
      .join("");
    assert.equal(args, '{"path":"a.txt"}');
    assert.deepEqual(JSON.parse(args), { path: "a.txt" });

    assert.ok(deltas.some((d) => d.type === "tool_end"), "emits tool_end");
    assert.equal((deltas.at(-1) as any).reason, "tool_use");
  });

  it("keeps two concurrent tool calls separate", async () => {
    status = 200;
    chunks = [
      msgStart(),
      blockStart(0, "tool_use", { id: "a", name: "file_read" }),
      blockDelta(0, { type: "input_json_delta", partial_json: '{"p":1}' }),
      blockStop(0),
      blockStart(1, "tool_use", { id: "b", name: "file_write" }),
      blockDelta(1, { type: "input_json_delta", partial_json: '{"p":2}' }),
      blockStop(1),
      msgDelta("tool_use"),
      msgStop(),
    ];

    const deltas = await collect();
    const names = deltas
      .filter((d) => d.type === "tool_start")
      .map((d) => (d as any).name);
    assert.deepEqual(names.sort(), ["file_read", "file_write"]);

    // Each call has its own args
    const fileReadArgs = deltas
      .filter((d) => d.type === "tool_args" && (d as any).id === "a")
      .map((d) => (d as any).partial)
      .join("");
    assert.deepEqual(JSON.parse(fileReadArgs), { p: 1 });

    const fileWriteArgs = deltas
      .filter((d) => d.type === "tool_args" && (d as any).id === "b")
      .map((d) => (d as any).partial)
      .join("");
    assert.deepEqual(JSON.parse(fileWriteArgs), { p: 2 });
  });

  it("emits stop reason tool_use when stop_reason is tool_use", async () => {
    status = 200;
    chunks = [
      msgStart(),
      blockStart(0, "tool_use", { id: "x", name: "shell" }),
      blockDelta(0, { type: "input_json_delta", partial_json: "{}" }),
      blockStop(0),
      msgDelta("tool_use"),
      msgStop(),
    ];
    const deltas = await collect();
    assert.equal((deltas.at(-1) as any).reason, "tool_use");
  });
});

describe("usage and errors", () => {
  it("surfaces usage when reported in message_delta", async () => {
    status = 200;
    chunks = [
      msgStart(15),
      blockStart(0, "text"),
      textDelta(0, "x"),
      blockStop(0),
      msgDelta("end_turn", 7),
      msgStop(),
    ];
    const deltas = await collect();
    const u = deltas.find((d) => d.type === "usage") as any;
    assert.ok(u, "emits usage");
    assert.equal(u.usage.inputTokens, 15);
    assert.equal(u.usage.outputTokens, 7);
  });

  it("raises the vendor's own message on HTTP error", async () => {
    status = 400;
    chunks = [JSON.stringify({ error: { message: "model does not support tools" } })];
    await assert.rejects(collect(), /model does not support tools/);
  });

  it("always terminates with exactly one stop delta", async () => {
    status = 200;
    chunks = [
      msgStart(),
      blockStart(0, "text"),
      textDelta(0, "a"),
      blockStop(0),
      msgDelta("end_turn"),
      msgStop(),
    ];
    const deltas = await collect();
    assert.equal(deltas.filter((d) => d.type === "stop").length, 1);
  });

  it("emits thinking deltas", async () => {
    status = 200;
    chunks = [
      msgStart(),
      blockStart(0, "text"),
      blockDelta(0, { type: "thinking_delta", thinking: "let me think" }),
      textDelta(0, "answer"),
      blockStop(0),
      msgDelta("end_turn"),
    ];
    const deltas = await collect();
    const thinking = deltas.filter((d) => d.type === "thinking");
    assert.ok(thinking.length > 0, "emits thinking deltas");
    assert.equal((thinking[0] as any).text, "let me think");
  });
});

describe("request shaping", () => {
  it("sends system as a top-level field, not a message", async () => {
    status = 200;
    chunks = [
      msgStart(),
      blockStart(0, "text"),
      textDelta(0, "ok"),
      blockStop(0),
      msgDelta("end_turn"),
    ];
    await collect();
    assert.equal(typeof lastBody.system, "string", "system must be top-level string");
    assert.equal(lastBody.system, "You are a test.");
    // Must not appear inside messages
    assert.ok(
      !lastBody.messages?.some((m: any) => m.role === "system"),
      "no system role in messages",
    );
  });

  it("sends x-api-key header, not Authorization", async () => {
    status = 200;
    chunks = [
      msgStart(),
      blockStart(0, "text"),
      textDelta(0, "ok"),
      blockStop(0),
      msgDelta("end_turn"),
    ];
    await collect();
    assert.ok(lastHeaders["x-api-key"], "x-api-key header must be present");
    assert.ok(!lastHeaders["authorization"], "Authorization header must not be present");
  });

  it("sends images as base64 source blocks", async () => {
    status = 200;
    chunks = [
      msgStart(),
      blockStart(0, "text"),
      textDelta(0, "ok"),
      blockStop(0),
      msgDelta("end_turn"),
    ];
    await collect([
      {
        id: "m",
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          { type: "image", mimeType: "image/png", data: "aGk=" },
        ],
        createdAt: 0,
      },
    ]);
    const userMsg = lastBody.messages.find((m: any) => m.role === "user");
    assert.ok(Array.isArray(userMsg.content));
    const img = userMsg.content.find((b: any) => b.type === "image");
    assert.ok(img, "image block present");
    assert.equal(img.source.type, "base64");
    assert.equal(img.source.media_type, "image/png");
    assert.equal(img.source.data, "aGk=");
  });

  it("sends tool results as tool_result blocks in a user message", async () => {
    status = 200;
    chunks = [
      msgStart(),
      blockStart(0, "text"),
      textDelta(0, "ok"),
      blockStop(0),
      msgDelta("end_turn"),
    ];
    await collect([
      userMsg("first"),
      {
        id: "a",
        role: "assistant",
        content: [{ type: "tool_use", id: "tu1", name: "file_read", input: { path: "x" } }],
        createdAt: 0,
      },
      {
        id: "r",
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "tu1",
            content: [{ type: "text", text: "contents" }],
            isError: false,
          },
          { type: "text", text: "now summarise" },
        ],
        createdAt: 0,
      },
    ]);

    // Find the user message that has a tool_result block
    const toolResultMsg = lastBody.messages.find(
      (m: any) => m.role === "user" && m.content?.some((b: any) => b.type === "tool_result"),
    );
    assert.ok(toolResultMsg, "tool_result must be in a user message");
    const tr = toolResultMsg.content.find((b: any) => b.type === "tool_result");
    assert.equal(tr.tool_use_id, "tu1");
  });

  it("sends tool definitions with input_schema, not parameters", async () => {
    status = 200;
    chunks = [
      msgStart(),
      blockStart(0, "text"),
      textDelta(0, "ok"),
      blockStop(0),
      msgDelta("end_turn"),
    ];

    const adapter = new AnthropicMessagesAdapter();
    const out: StreamDelta[] = [];
    for await (const d of adapter.stream(ctx(), {
      model: "claude-sonnet-4-6",
      system: "test",
      messages: [userMsg("hi")],
      tools: [
        {
          name: "file_read",
          title: "File Read",
          description: "Read a file",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string", description: "path" } },
            required: ["path"],
          },
          icon: "file",
          group: "filesystem",
          modes: ["cowork"],
        },
      ],
      maxTokens: 128,
      temperature: 0,
      signal: new AbortController().signal,
    })) {
      out.push(d);
    }

    assert.ok(Array.isArray(lastBody.tools), "tools array present");
    const tool = lastBody.tools[0];
    assert.ok(tool.input_schema, "input_schema must be present");
    assert.ok(!tool.parameters, "parameters must not be present");
    assert.equal(tool.name, "file_read");
  });
});

describe("listModels", () => {
  it("parses the Anthropic catalogue shape", async () => {
    status = 200;
    chunks = [
      JSON.stringify({
        data: [
          { id: "claude-opus-4-6", display_name: "Claude Opus 4.6" },
          { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" },
        ],
      }),
    ];

    const adapter = new AnthropicMessagesAdapter();
    const models = await adapter.listModels(ctx());
    assert.ok(Array.isArray(models), "returns array");
    assert.ok(models!.length >= 2);
    const opus = models!.find((m) => m.id === "claude-opus-4-6");
    assert.ok(opus, "finds claude-opus-4-6");
    assert.equal(opus!.displayName, "Claude Opus 4.6");
  });
});
