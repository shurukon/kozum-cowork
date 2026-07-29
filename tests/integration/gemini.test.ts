/**
 * Gemini adapter — integration tests against a real HTTP server.
 *
 * Stands up an actual node:http server emitting real SSE bytes and drives the
 * real adapter over the real network stack. Follows the openai-chat.test.ts
 * pattern exactly.
 *
 * Gemini-specific assertions:
 *  - Synthetic tool-call ids are stable (same id for start/args/end).
 *  - functionResponse parts land in a user-role turn.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { GeminiAdapter } from "../../src/main/providers/adapters/gemini.ts";
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

      if (req.url?.includes("/models") && !req.url?.includes(":streamGenerateContent")) {
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
    providerId: "google-ai-studio",
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
  const adapter = new GeminiAdapter();
  const out: StreamDelta[] = [];
  for await (const d of adapter.stream(ctx(), {
    model: "gemini-2.5-flash",
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

const textFrame = (text: string, finishReason?: string) =>
  sse({
    candidates: [
      {
        content: { role: "model", parts: [{ text }] },
        ...(finishReason ? { finishReason } : {}),
      },
    ],
  });

const stopFrame = (finishReason = "STOP") =>
  sse({
    candidates: [{ content: { role: "model", parts: [] }, finishReason }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
  });

const funcCallFrame = (name: string, args: Record<string, unknown>, finishReason?: string) =>
  sse({
    candidates: [
      {
        content: { role: "model", parts: [{ functionCall: { name, args } }] },
        ...(finishReason ? { finishReason } : {}),
      },
    ],
  });

/* ------------------------------------------------------------------------ */

describe("streaming text", () => {
  it("assembles simple text deltas in order", async () => {
    status = 200;
    chunks = [textFrame("Hello"), textFrame(", "), textFrame("world"), stopFrame()];

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
    const frame = textFrame("split-me");
    chunks = [frame.slice(0, 10), frame.slice(10, 25), frame.slice(25), stopFrame()];

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
    const frame = Buffer.from(textFrame(arabic + emoji), "utf8");

    const cut = frame.indexOf(Buffer.from(arabic, "utf8")) + 5;
    chunks = [frame.subarray(0, cut), frame.subarray(cut), stopFrame()];

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
  it("emits tool_start, tool_args (full JSON), tool_end for a function call", async () => {
    status = 200;
    chunks = [
      funcCallFrame("file_read", { path: "a.txt" }, "STOP"),
      stopFrame(),
    ];

    const deltas = await collect();
    const start = deltas.find((d) => d.type === "tool_start");
    assert.ok(start, "emits tool_start");
    assert.equal((start as any).name, "file_read");

    const args = deltas
      .filter((d) => d.type === "tool_args")
      .map((d) => (d as any).partial)
      .join("");
    assert.deepEqual(JSON.parse(args), { path: "a.txt" });

    assert.ok(deltas.some((d) => d.type === "tool_end"), "emits tool_end");
    assert.equal((deltas.at(-1) as any).reason, "tool_use");
  });

  it("generates a stable synthetic tool-call id (same across start/args/end)", async () => {
    status = 200;
    chunks = [funcCallFrame("shell", { cmd: "ls" }), stopFrame()];

    const deltas = await collect();
    const start = deltas.find((d) => d.type === "tool_start") as any;
    const args = deltas.find((d) => d.type === "tool_args") as any;
    const end = deltas.find((d) => d.type === "tool_end") as any;

    assert.ok(start, "has tool_start");
    assert.equal(args.id, start.id, "tool_args id matches tool_start id");
    assert.equal(end.id, start.id, "tool_end id matches tool_start id");
  });

  it("keeps two concurrent tool calls separate", async () => {
    status = 200;
    // Gemini delivers both function calls in one frame's parts array.
    chunks = [
      sse({
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                { functionCall: { name: "file_read", args: { p: 1 } } },
                { functionCall: { name: "file_write", args: { p: 2 } } },
              ],
            },
            finishReason: "STOP",
          },
        ],
      }),
      stopFrame(),
    ];

    const deltas = await collect();
    const starts = deltas.filter((d) => d.type === "tool_start");
    assert.equal(starts.length, 2, "two tool_start events");
    const names = starts.map((d) => (d as any).name);
    assert.deepEqual(names.sort(), ["file_read", "file_write"]);

    // Ids must be different
    const ids = starts.map((d) => (d as any).id);
    assert.notEqual(ids[0], ids[1], "each call gets a distinct id");
  });

  it("emits stop reason tool_use for function calls", async () => {
    status = 200;
    chunks = [funcCallFrame("test", {}, "STOP"), stopFrame()];
    const deltas = await collect();
    assert.equal((deltas.at(-1) as any).reason, "tool_use");
  });

  it("always terminates with exactly one stop delta", async () => {
    status = 200;
    chunks = [funcCallFrame("test", {}), stopFrame()];
    const deltas = await collect();
    assert.equal(deltas.filter((d) => d.type === "stop").length, 1);
  });
});

describe("usage and errors", () => {
  it("surfaces usage from usageMetadata", async () => {
    status = 200;
    chunks = [
      textFrame("x"),
      sse({
        candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 4 },
      }),
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

  it("maps MAX_TOKENS finish reason to max_tokens", async () => {
    status = 200;
    chunks = [
      textFrame("partial"),
      sse({
        candidates: [{ content: { role: "model", parts: [] }, finishReason: "MAX_TOKENS" }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 10 },
      }),
    ];
    const deltas = await collect();
    assert.equal((deltas.at(-1) as any).reason, "max_tokens");
  });
});

describe("request shaping", () => {
  it("sends system as systemInstruction, not a contents entry", async () => {
    status = 200;
    chunks = [textFrame("ok"), stopFrame()];
    await collect();
    assert.ok(lastBody.systemInstruction, "systemInstruction present");
    assert.equal(lastBody.systemInstruction.parts[0].text, "You are a test.");
    // Must not appear as a user/model role in contents
    assert.ok(
      !lastBody.contents?.some((c: any) => c.role === "system"),
      "no system role in contents",
    );
  });

  it("uses x-goog-api-key header, not query param or Authorization", async () => {
    status = 200;
    chunks = [textFrame("ok"), stopFrame()];
    await collect();
    assert.ok(lastHeaders["x-goog-api-key"], "x-goog-api-key must be set");
    assert.ok(!lastHeaders["authorization"], "no Authorization header");
  });

  it("uses 'model' role for assistant messages, not 'assistant'", async () => {
    status = 200;
    chunks = [textFrame("ok"), stopFrame()];
    await collect([
      userMsg("hi"),
      {
        id: "a",
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        createdAt: 0,
      },
      userMsg("go"),
    ]);
    const roles = lastBody.contents.map((c: any) => c.role);
    assert.ok(!roles.includes("assistant"), "no 'assistant' role in Gemini request");
    assert.ok(roles.includes("model"), "'model' role used for assistant turns");
  });

  it("sends functionResponse in a user-role turn", async () => {
    status = 200;
    chunks = [textFrame("ok"), stopFrame()];
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
        ],
        createdAt: 0,
      },
    ]);

    const userTurnWithFuncResp = lastBody.contents?.find(
      (c: any) =>
        c.role === "user" &&
        c.parts?.some((p: any) => p.functionResponse),
    );
    assert.ok(userTurnWithFuncResp, "functionResponse must be in a user-role turn");
  });

  it("sends images as inlineData parts", async () => {
    status = 200;
    chunks = [textFrame("ok"), stopFrame()];
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
    const userContent = lastBody.contents.find((c: any) => c.role === "user");
    const imgPart = userContent?.parts?.find((p: any) => p.inlineData);
    assert.ok(imgPart, "inlineData part present");
    assert.equal(imgPart.inlineData.mimeType, "image/png");
    assert.equal(imgPart.inlineData.data, "aGk=");
  });
});

describe("listModels", () => {
  it("parses the Gemini catalogue shape and strips models/ prefix", async () => {
    status = 200;
    chunks = [
      JSON.stringify({
        models: [
          {
            name: "models/gemini-2.5-flash",
            displayName: "Gemini 2.5 Flash",
            inputTokenLimit: 1048576,
            outputTokenLimit: 8192,
            supportedGenerationMethods: ["generateContent"],
          },
          {
            name: "models/gemini-2.5-pro",
            displayName: "Gemini 2.5 Pro",
            inputTokenLimit: 2097152,
            outputTokenLimit: 8192,
            supportedGenerationMethods: ["generateContent"],
          },
        ],
      }),
    ];

    const adapter = new GeminiAdapter();
    const models = await adapter.listModels(ctx());
    assert.ok(Array.isArray(models));
    assert.ok(models!.length >= 2);

    const flash = models!.find((m) => m.id === "gemini-2.5-flash");
    assert.ok(flash, "finds gemini-2.5-flash");
    assert.equal(flash!.displayName, "Gemini 2.5 Flash");
    // id must not have models/ prefix
    assert.ok(!flash!.id.startsWith("models/"), "id must not have models/ prefix");
  });
});
