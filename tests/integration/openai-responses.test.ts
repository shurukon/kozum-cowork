/**
 * OpenAI Responses API adapter — integration tests against a real HTTP server.
 *
 * Stands up an actual node:http server emitting real SSE bytes and drives the
 * real adapter over the real network stack. Follows the openai-chat.test.ts
 * pattern exactly.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { OpenAiResponsesAdapter } from "../../src/main/providers/adapters/openai-responses.ts";
import type { ProviderContext, StreamDelta } from "../../src/main/providers/adapter.ts";
import type { Message } from "../../src/shared/types.ts";

let chunks: (string | Buffer)[] = [];
let status = 200;
let lastBody: any = null;

let server: http.Server;
let base = "";

before(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      try {
        lastBody = raw ? JSON.parse(raw) : null;
      } catch {
        lastBody = raw;
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
    providerId: "test",
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
  const adapter = new OpenAiResponsesAdapter();
  const out: StreamDelta[] = [];
  for await (const d of adapter.stream(ctx(), {
    model: "gpt-5.2",
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

const textDelta = (text: string, itemId = "item_0") =>
  sse({ type: "response.output_text.delta", item_id: itemId, delta: text });

const completed = (inputTokens = 10, outputTokens = 5) =>
  sse({
    type: "response.completed",
    response: {
      status: "completed",
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    },
  });

const functionCallAdded = (itemId: string, callId: string, name: string) =>
  sse({
    type: "response.output_item.added",
    item_id: itemId,
    item: { type: "function_call", call_id: callId, name },
  });

const funcArgsDelta = (itemId: string, delta: string) =>
  sse({ type: "response.function_call_arguments.delta", item_id: itemId, delta });

/* ------------------------------------------------------------------------ */

describe("streaming text", () => {
  it("assembles simple text deltas in order", async () => {
    status = 200;
    chunks = [
      textDelta("Hello"),
      textDelta(", "),
      textDelta("world"),
      completed(),
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
    const frame = textDelta("split-me");
    chunks = [
      frame.slice(0, 10),
      frame.slice(10, 25),
      frame.slice(25),
      completed(),
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
    const frame = Buffer.from(textDelta(arabic + emoji), "utf8");

    const cut = frame.indexOf(Buffer.from(arabic, "utf8")) + 5;
    chunks = [frame.subarray(0, cut), frame.subarray(cut), completed()];

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
  it("assembles a tool call from Responses API events", async () => {
    status = 200;
    chunks = [
      functionCallAdded("item_0", "call_1", "file_read"),
      funcArgsDelta("item_0", '{"pa'),
      funcArgsDelta("item_0", 'th":"a.txt"}'),
      completed(),
    ];

    const deltas = await collect();
    const start = deltas.find((d) => d.type === "tool_start");
    assert.ok(start, "emits tool_start");
    assert.equal((start as any).name, "file_read");
    assert.equal((start as any).id, "call_1");

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
      functionCallAdded("item_0", "ca", "file_read"),
      functionCallAdded("item_1", "cb", "file_write"),
      funcArgsDelta("item_0", '{"p":1}'),
      funcArgsDelta("item_1", '{"p":2}'),
      completed(),
    ];

    const deltas = await collect();
    const names = deltas
      .filter((d) => d.type === "tool_start")
      .map((d) => (d as any).name);
    assert.deepEqual(names.sort(), ["file_read", "file_write"]);

    const readArgs = deltas
      .filter((d) => d.type === "tool_args" && (d as any).id === "ca")
      .map((d) => (d as any).partial)
      .join("");
    assert.deepEqual(JSON.parse(readArgs), { p: 1 });

    const writeArgs = deltas
      .filter((d) => d.type === "tool_args" && (d as any).id === "cb")
      .map((d) => (d as any).partial)
      .join("");
    assert.deepEqual(JSON.parse(writeArgs), { p: 2 });
  });

  it("emits exactly one stop delta per stream", async () => {
    status = 200;
    chunks = [
      functionCallAdded("item_0", "cx", "shell"),
      funcArgsDelta("item_0", "{}"),
      completed(),
    ];
    const deltas = await collect();
    assert.equal(deltas.filter((d) => d.type === "stop").length, 1);
  });
});

describe("usage and errors", () => {
  it("surfaces usage from response.completed", async () => {
    status = 200;
    chunks = [textDelta("x"), completed(11, 4)];
    const deltas = await collect();
    const u = deltas.find((d) => d.type === "usage") as any;
    assert.ok(u, "emits usage");
    assert.equal(u.usage.inputTokens, 11);
    assert.equal(u.usage.outputTokens, 4);
  });

  it("raises the vendor's own message on HTTP error", async () => {
    status = 400;
    chunks = [JSON.stringify({ error: { message: "model does not support tools" } })];
    await assert.rejects(collect(), /model does not support tools/);
  });

  it("always terminates with exactly one stop delta", async () => {
    status = 200;
    chunks = [textDelta("a"), completed()];
    const deltas = await collect();
    assert.equal(deltas.filter((d) => d.type === "stop").length, 1);
  });

  it("maps response.incomplete to max_tokens stop reason", async () => {
    status = 200;
    chunks = [
      textDelta("partial"),
      sse({
        type: "response.completed",
        response: {
          status: "incomplete",
          usage: { input_tokens: 5, output_tokens: 10 },
        },
      }),
    ];
    const deltas = await collect();
    const stop = deltas.at(-1) as any;
    assert.equal(stop.type, "stop");
    assert.equal(stop.reason, "max_tokens");
  });
});

describe("request shaping", () => {
  it("sends system as instructions field", async () => {
    status = 200;
    chunks = [textDelta("ok"), completed()];
    await collect();
    assert.equal(lastBody.instructions, "You are a test.", "instructions must be set");
    assert.ok(!lastBody.system, "system field must not be present");
  });

  it("sends input_text parts for text turns", async () => {
    status = 200;
    chunks = [textDelta("ok"), completed()];
    await collect();
    const userItem = lastBody.input?.find((i: any) => i.role === "user");
    assert.ok(userItem, "user input item present");
    const textPart = userItem.content?.find((p: any) => p.type === "input_text");
    assert.ok(textPart, "input_text part present");
    assert.equal(textPart.text, "hi");
  });

  it("sends images as input_image parts", async () => {
    status = 200;
    chunks = [textDelta("ok"), completed()];
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
    const userItem = lastBody.input?.find((i: any) => i.role === "user");
    const imgPart = userItem?.content?.find((p: any) => p.type === "input_image");
    assert.ok(imgPart, "input_image part present");
    assert.match(imgPart.image_url, /^data:image\/png;base64,aGk=$/);
  });

  it("sends tool results as function_call_output items", async () => {
    status = 200;
    chunks = [textDelta("ok"), completed()];
    await collect([
      userMsg("first"),
      {
        id: "a",
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "file_read", input: { path: "x" } }],
        createdAt: 0,
      },
      {
        id: "r",
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "t1",
            content: [{ type: "text", text: "contents" }],
            isError: false,
          },
        ],
        createdAt: 0,
      },
    ]);

    const funcOut = lastBody.input?.find((i: any) => i.type === "function_call_output");
    assert.ok(funcOut, "function_call_output item present");
    assert.equal(funcOut.call_id, "t1");
  });

  it("sends tool definitions with type:function", async () => {
    status = 200;
    chunks = [textDelta("ok"), completed()];

    const adapter = new OpenAiResponsesAdapter();
    const out: StreamDelta[] = [];
    for await (const d of adapter.stream(ctx(), {
      model: "gpt-5.2",
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

    assert.ok(Array.isArray(lastBody.tools));
    const tool = lastBody.tools[0];
    assert.equal(tool.type, "function");
    assert.equal(tool.name, "file_read");
    assert.ok(tool.parameters, "parameters present");
  });
});
