/**
 * OpenAI-chat adapter — integration tests against a real HTTP server.
 *
 * No mocking library and no stubbed fetch: we stand up an actual node:http
 * server, write actual SSE bytes at it, and drive the real adapter over the
 * real network stack. The failures this catches (chunk-straddling UTF-8,
 * missing tool-call indices, absent finish_reason) are exactly the ones a
 * hand-written mock would paper over, because a mock reflects what you already
 * believe the wire looks like.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { OpenAiChatAdapter } from "../../src/main/providers/adapters/openai-chat.ts";
import { parseSSE } from "../../src/main/providers/adapter.ts";
import type { ProviderContext, StreamDelta } from "../../src/main/providers/adapter.ts";
import type { Message } from "../../src/shared/types.ts";

/** Per-test script: the exact byte chunks the server will emit. */
let chunks: (string | Buffer)[] = [];
let status = 200;
let jsonResponse = false;
let jsonResponses: string[] = [];
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

      if (req.url?.endsWith("/models")) {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(chunks.join(""));
        return;
      }

      if (status !== 200 || jsonResponse) {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(jsonResponses.shift() ?? chunks.join(""));
        if (!jsonResponses.length) jsonResponse = false;
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      // Write the scripted chunks verbatim, so tests control exactly where the
      // byte boundaries fall.
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
  const adapter = new OpenAiChatAdapter();
  const out: StreamDelta[] = [];
  for await (const d of adapter.stream(ctx(), {
    model: "test-model",
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

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const textDelta = (s: string) => sse({ choices: [{ delta: { content: s } }] });

/* ------------------------------------------------------------------------ */

describe("streaming text", () => {
  it("assembles simple text deltas in order", async () => {
    status = 200;
    chunks = [
      textDelta("Hello"),
      textDelta(", "),
      textDelta("world"),
      sse({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
    ];

    const deltas = await collect();
    const text = deltas
      .filter((d) => d.type === "text")
      .map((d) => (d as { text: string }).text)
      .join("");

    assert.equal(text, "Hello, world");
    const stop = deltas.at(-1);
    assert.equal(stop?.type, "stop");
    assert.equal((stop as { reason: string }).reason, "end_turn");
  });

  it("survives frames split across chunk boundaries", async () => {
    status = 200;
    const frame = textDelta("split-me");
    // Cut the frame in three arbitrary places, including mid-JSON.
    chunks = [
      frame.slice(0, 7),
      frame.slice(7, 20),
      frame.slice(20),
      sse({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    ];

    const deltas = await collect();
    const text = deltas
      .filter((d) => d.type === "text")
      .map((d) => (d as { text: string }).text)
      .join("");
    assert.equal(text, "split-me");
  });

  it("does not corrupt multi-byte UTF-8 split across chunks", async () => {
    // The reason parseSSE decodes with {stream:true} against a carry buffer.
    // Arabic and emoji are multi-byte; a naive per-chunk toString() mangles them.
    status = 200;
    const arabic = "مرحبا بك في كوزوم";
    const emoji = "🚀✅";
    const frame = Buffer.from(textDelta(arabic + emoji), "utf8");

    // Slice at a byte offset guaranteed to land mid-codepoint.
    const cut = frame.indexOf(Buffer.from(arabic, "utf8")) + 5;
    chunks = [
      frame.subarray(0, cut),
      frame.subarray(cut),
      sse({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    ];

    const deltas = await collect();
    const text = deltas
      .filter((d) => d.type === "text")
      .map((d) => (d as { text: string }).text)
      .join("");

    assert.equal(text, arabic + emoji, "multi-byte text must survive chunk splits");
    assert.ok(!text.includes("�"), "no replacement characters");
  });

  it("ignores comments and keepalive frames", async () => {
    status = 200;
    chunks = [
      ": keepalive\n\n",
      textDelta("a"),
      ":\n\n",
      "event: ping\ndata: {}\n\n",
      textDelta("b"),
      sse({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    ];
    const deltas = await collect();
    const text = deltas
      .filter((d) => d.type === "text")
      .map((d) => (d as { text: string }).text)
      .join("");
    assert.equal(text, "ab");
  });

  it("handles CRLF frame separators", async () => {
    status = 200;
    chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "crlf" } }] })}\r\n\r\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\r\n\r\n`,
    ];
    const deltas = await collect();
    assert.equal(
      deltas.filter((d) => d.type === "text").map((d) => (d as any).text).join(""),
      "crlf",
    );
  });
});

describe("stream reliability", () => {
  it("fails a stalled response with an idle timeout instead of hanging", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
    });
    const controller = new AbortController();
    await assert.rejects(
      async () => {
        for await (const _payload of parseSSE(body, controller.signal, 20)) {
          // The test stream never emits a frame.
        }
      },
      /idle timeout/i,
    );
  });
});

describe("non-streaming compatibility", () => {
  it("falls back to a real JSON completion when the gateway rejects streaming", async () => {
    status = 200;
    jsonResponse = true;
    jsonResponses = [
      JSON.stringify({ error: { message: "Streaming is not supported" } }),
      JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: "Created.",
            tool_calls: [{ id: "call_json", type: "function", function: { name: "file_write", arguments: '{"path":"live.html","content":"ok"}' } }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 8 },
      }),
    ];

    const adapter = new OpenAiChatAdapter();
    const deltas: StreamDelta[] = [];
    for await (const delta of adapter.stream(ctx(), {
      model: "test-model",
      system: "You are a test.",
      messages: [userMsg("create a file")],
      tools: [{ name: "file_write", description: "write", inputSchema: { type: "object" } } as any],
      maxTokens: 128,
      temperature: 0,
      toolChoice: "required",
      signal: new AbortController().signal,
    })) deltas.push(delta);

    assert.equal(lastBody?.stream, false);
    assert.ok(deltas.some((d) => d.type === "text" && d.text === "Created."));
    assert.ok(deltas.some((d) => d.type === "tool_start" && d.name === "file_write"));
    assert.equal(deltas.filter((d) => d.type === "tool_args").map((d: any) => d.partial).join(""), '{"path":"live.html","content":"ok"}');
    assert.equal((deltas.at(-1) as any).reason, "tool_use");
  });
});

describe("tool calls", () => {
  it("assembles a tool call streamed across deltas", async () => {
    status = 200;
    chunks = [
      sse({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", function: { name: "file_read", arguments: "" } },
              ],
            },
          },
        ],
      }),
      sse({
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] } },
        ],
      }),
      sse({
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] } },
        ],
      }),
      sse({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
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

  it("tolerates a missing index (single-call gateways)", async () => {
    status = 200;
    chunks = [
      sse({
        choices: [
          { delta: { tool_calls: [{ id: "c9", function: { name: "shell_exec" } }] } },
        ],
      }),
      sse({
        choices: [{ delta: { tool_calls: [{ function: { arguments: "{}" } }] } }],
      }),
      sse({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    ];
    const deltas = await collect();
    const starts = deltas.filter((d) => d.type === "tool_start");
    assert.equal(starts.length, 1, "exactly one tool_start despite missing index");
    assert.equal((starts[0] as any).name, "shell_exec");
  });

  it("infers tool_use when finish_reason is absent", async () => {
    // Several gateways never send finish_reason at all.
    status = 200;
    chunks = [
      sse({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "x", function: { name: "glob_match", arguments: "{}" } }],
            },
          },
        ],
      }),
      "data: [DONE]\n\n",
    ];
    const deltas = await collect();
    assert.equal((deltas.at(-1) as any).reason, "tool_use");
  });

  it("keeps two concurrent tool calls separate", async () => {
    status = 200;
    chunks = [
      sse({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "a", function: { name: "file_read", arguments: '{"p":1}' } },
                { index: 1, id: "b", function: { name: "file_write", arguments: '{"p":2}' } },
              ],
            },
          },
        ],
      }),
      sse({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    ];
    const deltas = await collect();
    const names = deltas
      .filter((d) => d.type === "tool_start")
      .map((d) => (d as any).name);
    assert.deepEqual(names.sort(), ["file_read", "file_write"]);
  });
});

describe("usage and errors", () => {
  it("surfaces usage when the vendor reports it", async () => {
    status = 200;
    chunks = [
      textDelta("x"),
      sse({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 4 } }),
    ];
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

  it("raises errors delivered inline in the stream", async () => {
    status = 200;
    chunks = [textDelta("partial"), sse({ error: { message: "upstream exploded" } })];
    await assert.rejects(collect(), /upstream exploded/);
  });

  it("always terminates with exactly one stop delta", async () => {
    status = 200;
    chunks = [textDelta("a"), "data: [DONE]\n\n"];
    const deltas = await collect();
    assert.equal(deltas.filter((d) => d.type === "stop").length, 1);
  });
});

describe("request shaping", () => {
  it("sends text-only turns as a bare string, not an array", async () => {
    status = 200;
    chunks = [sse({ choices: [{ delta: {}, finish_reason: "stop" }] })];
    await collect();
    const userTurn = lastBody.messages.find((m: any) => m.role === "user");
    assert.equal(typeof userTurn.content, "string", "gateways reject arrays for text-only");
  });

  it("sends image turns as a content-part array", async () => {
    status = 200;
    chunks = [sse({ choices: [{ delta: {}, finish_reason: "stop" }] })];
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
    const userTurn = lastBody.messages.find((m: any) => m.role === "user");
    assert.ok(Array.isArray(userTurn.content));
    const img = userTurn.content.find((p: any) => p.type === "image_url");
    assert.match(img.image_url.url, /^data:image\/png;base64,aGk=$/);
  });

  it("emits tool results as role:tool before sibling user content", async () => {
    status = 200;
    chunks = [sse({ choices: [{ delta: {}, finish_reason: "stop" }] })];
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
          { type: "tool_result", toolUseId: "t1", content: [{ type: "text", text: "contents" }], isError: false },
          { type: "text", text: "now summarise" },
        ],
        createdAt: 0,
      },
    ]);

    const roles = lastBody.messages.map((m: any) => m.role);
    const assistantIdx = roles.indexOf("assistant");
    const toolIdx = roles.indexOf("tool");
    assert.ok(toolIdx > assistantIdx, "tool result must follow the assistant tool_call");
    const lastUser = roles.lastIndexOf("user");
    assert.ok(lastUser > toolIdx, "sibling user text comes after the tool result");
    assert.equal(lastBody.messages[toolIdx].tool_call_id, "t1");
  });

  it("puts the system prompt first", async () => {
    status = 200;
    chunks = [sse({ choices: [{ delta: {}, finish_reason: "stop" }] })];
    await collect();
    assert.equal(lastBody.messages[0].role, "system");
    assert.equal(lastBody.messages[0].content, "You are a test.");
  });
});
