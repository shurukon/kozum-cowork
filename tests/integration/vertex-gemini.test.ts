/**
 * Vertex AI Gemini adapter — integration tests against a real HTTP server.
 *
 * Stands up actual node:http servers (one for the Gemini API, one for the
 * OAuth token endpoint). Drives the real adapter over the real network stack.
 * Follows the openai-chat.test.ts pattern exactly.
 *
 * Vertex-specific assertions:
 *  - The request URL contains both projectId and region.
 *  - A service-account JSON triggers a token exchange against the token server.
 *  - A raw access token is used directly without any exchange.
 *
 * An ephemeral RSA keypair is generated with node:crypto so no real credentials
 * ever appear in the test.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";

import { VertexGeminiAdapter } from "../../src/main/providers/adapters/vertex-gemini.ts";
import type { ProviderContext, StreamDelta } from "../../src/main/providers/adapter.ts";
import type { Message } from "../../src/shared/types.ts";

/* -------------------------------------------------- test servers ---- */

let apiChunks: (string | Buffer)[] = [];
let apiStatus = 200;
let lastApiUrl = "";
let lastApiHeaders: Record<string, string | string[] | undefined> = {};

let tokenStatus = 200;
let lastTokenBody = "";

let apiServer: http.Server;
let tokenServer: http.Server;
let apiBase = "";
let tokenBase = "";

// Ephemeral RSA keypair for tests — never commit a real key.
const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

before(async () => {
  // API server (stands in for Vertex AI endpoint)
  apiServer = http.createServer((req, res) => {
    lastApiUrl = req.url ?? "";
    lastApiHeaders = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k, v]),
    );
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      if (apiStatus !== 200) {
        res.writeHead(apiStatus, { "Content-Type": "application/json" });
        res.end(apiChunks.join(""));
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      for (const c of apiChunks) res.write(c);
      res.end();
    });
  });

  // Token server (stands in for oauth2.googleapis.com/token)
  tokenServer = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      lastTokenBody = raw;
      if (tokenStatus !== 200) {
        res.writeHead(tokenStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ access_token: "test-access-token-from-exchange", expires_in: 3600 }));
    });
  });

  await Promise.all([
    new Promise<void>((r) => apiServer.listen(0, "127.0.0.1", r)),
    new Promise<void>((r) => tokenServer.listen(0, "127.0.0.1", r)),
  ]);

  apiBase = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;
  tokenBase = `http://127.0.0.1:${(tokenServer.address() as AddressInfo).port}/token`;
});

after(() =>
  Promise.all([
    new Promise<void>((r) => apiServer.close(() => r())),
    new Promise<void>((r) => tokenServer.close(() => r())),
  ]),
);

function ctx(overrides: Partial<ProviderContext> = {}): ProviderContext {
  return {
    providerId: "vertex",
    baseUrl: apiBase,
    apiKey: "raw-access-token",
    meta: { projectId: "my-project", region: "us-central1" },
    extraHeaders: {},
    ...overrides,
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

function makeAdapter(): VertexGeminiAdapter {
  const adapter = new VertexGeminiAdapter();
  adapter.tokenEndpointOverride = tokenBase;
  return adapter;
}

async function collect(
  messages: Message[] = [userMsg("hi")],
  ctxOverride?: Partial<ProviderContext>,
): Promise<StreamDelta[]> {
  const adapter = makeAdapter();
  const out: StreamDelta[] = [];
  for await (const d of adapter.stream(ctx(ctxOverride), {
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

const textFrame = (text: string) =>
  sse({
    candidates: [{ content: { role: "model", parts: [{ text }] } }],
  });

const stopFrame = (finishReason = "STOP") =>
  sse({
    candidates: [{ content: { role: "model", parts: [] }, finishReason }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
  });

const funcCallFrame = (name: string, args: Record<string, unknown>) =>
  sse({
    candidates: [
      {
        content: { role: "model", parts: [{ functionCall: { name, args } }] },
        finishReason: "STOP",
      },
    ],
  });

/* ------------------------------------------------------------------------ */

describe("streaming text", () => {
  it("assembles simple text deltas in order", async () => {
    apiStatus = 200;
    apiChunks = [textFrame("Hello"), textFrame(", world"), stopFrame()];

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

  it("does not corrupt multi-byte UTF-8 split across chunks", async () => {
    apiStatus = 200;
    const arabic = "مرحبا بالعالم";
    const emoji = "🚀✅";
    const frame = Buffer.from(textFrame(arabic + emoji), "utf8");
    const cut = frame.indexOf(Buffer.from(arabic, "utf8")) + 5;
    apiChunks = [frame.subarray(0, cut), frame.subarray(cut), stopFrame()];

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
  it("emits tool_start, tool_args (full JSON), tool_end", async () => {
    apiStatus = 200;
    apiChunks = [funcCallFrame("file_read", { path: "a.txt" }), stopFrame()];

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

  it("generates a stable synthetic tool-call id", async () => {
    apiStatus = 200;
    apiChunks = [funcCallFrame("shell", { cmd: "ls" }), stopFrame()];

    const deltas = await collect();
    const start = deltas.find((d) => d.type === "tool_start") as any;
    const args = deltas.find((d) => d.type === "tool_args") as any;
    const end = deltas.find((d) => d.type === "tool_end") as any;

    assert.ok(start, "has tool_start");
    assert.equal(args.id, start.id, "tool_args id matches tool_start id");
    assert.equal(end.id, start.id, "tool_end id matches tool_start id");
  });

  it("keeps two concurrent tool calls separate", async () => {
    apiStatus = 200;
    apiChunks = [
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
    const names = deltas
      .filter((d) => d.type === "tool_start")
      .map((d) => (d as any).name);
    assert.deepEqual(names.sort(), ["file_read", "file_write"]);

    const ids = deltas
      .filter((d) => d.type === "tool_start")
      .map((d) => (d as any).id);
    assert.notEqual(ids[0], ids[1], "distinct ids for each call");
  });

  it("emits exactly one stop delta", async () => {
    apiStatus = 200;
    apiChunks = [funcCallFrame("test", {}), stopFrame()];
    const deltas = await collect();
    assert.equal(deltas.filter((d) => d.type === "stop").length, 1);
  });
});

describe("usage and errors", () => {
  it("surfaces usage from usageMetadata", async () => {
    apiStatus = 200;
    apiChunks = [
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
    apiStatus = 400;
    apiChunks = [JSON.stringify({ error: { message: "model does not support this" } })];
    await assert.rejects(collect(), /model does not support this/);
    apiStatus = 200;
  });

  it("throws ProviderError when projectId is missing", async () => {
    apiStatus = 200;
    apiChunks = [textFrame("ok"), stopFrame()];
    await assert.rejects(
      collect([userMsg("hi")], { meta: { region: "us-central1" } }),
      /projectId/,
    );
  });

  it("throws ProviderError when region is missing", async () => {
    apiStatus = 200;
    apiChunks = [textFrame("ok"), stopFrame()];
    await assert.rejects(
      collect([userMsg("hi")], { meta: { projectId: "proj" } }),
      /region/,
    );
  });
});

describe("URL structure", () => {
  it("includes project and region in the request URL", async () => {
    apiStatus = 200;
    apiChunks = [textFrame("ok"), stopFrame()];
    await collect();
    assert.ok(lastApiUrl.includes("my-project"), "URL must contain projectId");
    assert.ok(lastApiUrl.includes("us-central1"), "URL must contain region");
    assert.ok(lastApiUrl.includes(":streamGenerateContent"), "URL must have generate endpoint");
    assert.ok(lastApiUrl.includes("alt=sse"), "URL must have alt=sse");
  });

  it("sends Authorization: Bearer header for raw token", async () => {
    apiStatus = 200;
    apiChunks = [textFrame("ok"), stopFrame()];
    await collect([userMsg("hi")], { apiKey: "my-raw-token" });
    assert.equal(
      lastApiHeaders["authorization"],
      "Bearer my-raw-token",
      "raw token used directly",
    );
  });
});

describe("authentication", () => {
  it("uses a raw access token directly without token exchange", async () => {
    apiStatus = 200;
    apiChunks = [textFrame("ok"), stopFrame()];
    tokenStatus = 200;
    lastTokenBody = "";

    await collect([userMsg("hi")], { apiKey: "direct-token-xyz" });

    assert.equal(
      lastApiHeaders["authorization"],
      "Bearer direct-token-xyz",
      "raw token passed directly to API",
    );
    assert.equal(lastTokenBody, "", "token endpoint must NOT be called for raw tokens");
  });

  it("exchanges a service-account JSON for an access token", async () => {
    apiStatus = 200;
    apiChunks = [textFrame("ok"), stopFrame()];
    tokenStatus = 200;

    const saJson = JSON.stringify({
      type: "service_account",
      client_email: "test@project.iam.gserviceaccount.com",
      private_key: privateKeyPem,
    });

    // Use a fresh adapter to avoid the cache from a previous test run.
    const adapter = new VertexGeminiAdapter();
    adapter.tokenEndpointOverride = tokenBase;

    const deltas: StreamDelta[] = [];
    for await (const d of adapter.stream(ctx({ apiKey: saJson }), {
      model: "gemini-2.5-flash",
      system: "test",
      messages: [userMsg("hi")],
      tools: [],
      maxTokens: 128,
      temperature: 0,
      signal: new AbortController().signal,
    })) {
      deltas.push(d);
    }

    // The token endpoint must have been hit
    assert.ok(lastTokenBody.includes("assertion="), "JWT assertion must be sent to token endpoint");
    // The API call must use the exchanged token
    assert.equal(
      lastApiHeaders["authorization"],
      "Bearer test-access-token-from-exchange",
      "exchanged token used for API call",
    );
  });

  it("uses the cached token on the second call (no second exchange)", async () => {
    apiStatus = 200;
    apiChunks = [textFrame("ok"), stopFrame()];
    tokenStatus = 200;
    let tokenCallCount = 0;

    // Wrap the token server to count calls
    const origListener = tokenServer.listeners("request")[0] as (...args: any[]) => void;
    const counter = (...args: any[]) => {
      tokenCallCount++;
      origListener(...args);
    };
    tokenServer.removeAllListeners("request");
    tokenServer.on("request", counter);

    const saJson = JSON.stringify({
      type: "service_account",
      client_email: "cached@project.iam.gserviceaccount.com",
      private_key: privateKeyPem,
    });

    // Use a single adapter instance — it holds the cache.
    const adapter = new VertexGeminiAdapter();
    adapter.tokenEndpointOverride = tokenBase;

    for (let i = 0; i < 2; i++) {
      apiChunks = [textFrame("ok"), stopFrame()];
      for await (const _ of adapter.stream(ctx({ apiKey: saJson }), {
        model: "gemini-2.5-flash",
        system: "test",
        messages: [userMsg("hi")],
        tools: [],
        maxTokens: 128,
        temperature: 0,
        signal: new AbortController().signal,
      })) {
        // consume
      }
    }

    // Restore
    tokenServer.removeAllListeners("request");
    tokenServer.on("request", origListener);

    assert.ok(tokenCallCount <= 1, "token endpoint called at most once (cache hit on second call)");
  });
});

describe("listModels", () => {
  it("returns null (Vertex has no simple catalogue)", async () => {
    const adapter = makeAdapter();
    const models = await adapter.listModels(ctx());
    assert.equal(models, null);
  });
});
