/**
 * Gemini GenerateContent adapter (Google AI Studio / native API).
 *
 * Key differences from the OpenAI family:
 *  - Role is "user" or "model" (never "assistant" or "system").
 *  - The system prompt is a top-level `systemInstruction` field.
 *  - Function results go in a user-role turn as `functionResponse` parts.
 *  - Gemini sends complete, fully-parsed `functionCall` objects — there is no
 *    streamed JSON-fragment protocol like OpenAI's `arguments` deltas. Each
 *    SSE frame is a complete GenerateContentResponse.
 *  - There are no tool-call ids in the protocol, so we generate a stable
 *    synthetic one from a counter + model-turn context.
 *  - Auth: `x-goog-api-key` header (not a query param) to keep keys out of
 *    request URLs and server logs.
 *  - The `?alt=sse` query parameter is required; without it the API returns a
 *    JSON array rather than an event stream.
 *
 * This class is also subclassed by VertexGeminiAdapter, which overrides the
 * URL and auth logic but delegates all streaming parsing back here via
 * parseGeminiStream().
 */

import type {
  Message,
  ModelInfo,
  StopReason,
  ToolDefinition,
} from "../../../shared/types.ts";
import { resolveCapabilities } from "../capabilities.ts";
import {
  errorFromResponse,
  fetchWithRetry,
  parseSSE,
  ProviderError,
  type CompletionRequest,
  type ProviderAdapter,
  type ProviderContext,
  type StreamDelta,
} from "../adapter.ts";

/* -------------------------------------------------------- wire shapes --- */

type GeminiRole = "user" | "model";

interface GeminiTextPart {
  text: string;
}

interface GeminiInlineDataPart {
  inlineData: { mimeType: string; data: string };
}

interface GeminiFunctionCallPart {
  functionCall: { name: string; args: Record<string, unknown> };
}

interface GeminiFunctionResponsePart {
  functionResponse: { name: string; response: Record<string, unknown> };
}

type GeminiPart =
  | GeminiTextPart
  | GeminiInlineDataPart
  | GeminiFunctionCallPart
  | GeminiFunctionResponsePart;

interface GeminiContent {
  role: GeminiRole;
  parts: GeminiPart[];
}

/* -------------------------------------------------------- conversion --- */

export function toGeminiContents(messages: Message[]): GeminiContent[] {
  const out: GeminiContent[] = [];

  for (const m of messages) {
    if (m.role === "system") continue;

    if (m.role === "user") {
      const parts: GeminiPart[] = [];

      for (const b of m.content) {
        if (b.type === "tool_result") {
          // Function responses go in a user-role turn as functionResponse parts.
          parts.push({
            functionResponse: {
              name: b.toolUseId,
              response: {
                content: b.content
                  .map((c) => (c.type === "text" ? c.text : "[image omitted]"))
                  .join("\n"),
                is_error: b.isError,
              },
            },
          });
        } else if (b.type === "text" && b.text) {
          parts.push({ text: b.text });
        } else if (b.type === "image") {
          parts.push({ inlineData: { mimeType: b.mimeType, data: b.data } });
        }
      }

      if (parts.length) out.push({ role: "user", parts });
      continue;
    }

    // assistant → model
    const parts: GeminiPart[] = [];
    for (const b of m.content) {
      if (b.type === "text" && b.text) {
        parts.push({ text: b.text });
      } else if (b.type === "tool_use") {
        parts.push({
          functionCall: {
            name: b.name,
            args: (b.input as Record<string, unknown>) ?? {},
          },
        });
      }
    }
    if (parts.length) out.push({ role: "model", parts });
  }

  return out;
}

export function toGeminiTools(tools: ToolDefinition[]) {
  if (!tools.length) return undefined;
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      })),
    },
  ];
}

/* -------------------------------------------------- streaming parser --- */

/**
 * Parse a Gemini SSE stream and yield normalised StreamDeltas.
 *
 * Exported so VertexGeminiAdapter can reuse it without duplicating the logic.
 */
export async function* parseGeminiStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  toolCallCounter: { n: number },
): AsyncGenerator<StreamDelta> {
  // Map from synthetic tool id → name so we can emit tool_end.
  const activeCalls: { id: string; name: string }[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let finish: string | null = null;

  for await (const payload of parseSSE(body, signal)) {
    let evt: any;
    try {
      evt = JSON.parse(payload);
    } catch {
      continue;
    }

    // Usage accumulates across frames.
    const meta = evt.usageMetadata;
    if (meta) {
      if (typeof meta.promptTokenCount === "number") inputTokens = meta.promptTokenCount;
      if (typeof meta.candidatesTokenCount === "number") outputTokens = meta.candidatesTokenCount;
    }

    const candidate = evt.candidates?.[0];
    if (!candidate) continue;

    if (candidate.finishReason) finish = candidate.finishReason;

    const parts: GeminiPart[] = candidate.content?.parts ?? [];
    for (const part of parts) {
      const p = part as any;

      if (typeof p.text === "string" && p.text) {
        yield { type: "text", text: p.text };
        continue;
      }

      if (p.functionCall) {
        // Gemini delivers complete, parsed args in one shot — emit start,
        // single args delta with the full serialised object, then end.
        const syntheticId = `gemini_call_${toolCallCounter.n++}`;
        activeCalls.push({ id: syntheticId, name: p.functionCall.name });
        yield { type: "tool_start", id: syntheticId, name: p.functionCall.name };
        yield {
          type: "tool_args",
          id: syntheticId,
          partial: JSON.stringify(p.functionCall.args ?? {}),
        };
        yield { type: "tool_end", id: syntheticId };
        continue;
      }
    }
  }

  if (inputTokens > 0 || outputTokens > 0) {
    yield { type: "usage", usage: { inputTokens, outputTokens } };
  }

  yield { type: "stop", reason: mapFinish(finish, activeCalls.length > 0) };
}

/* ------------------------------------------------------------ adapter --- */

export class GeminiAdapter implements ProviderAdapter {
  readonly protocol = "gemini-generative";

  // Monotonic counter for synthetic tool-call ids. Scoped to the adapter
  // instance so concurrent streams within one process stay separate.
  private readonly _callCounter = { n: 0 };

  async *stream(
    ctx: ProviderContext,
    req: CompletionRequest,
  ): AsyncIterable<StreamDelta> {
    const body: Record<string, unknown> = {
      contents: toGeminiContents(req.messages),
      generationConfig: {
        maxOutputTokens: req.maxTokens,
        temperature: req.temperature,
      },
    };
    if (req.system.trim()) {
      body.systemInstruction = { parts: [{ text: req.system }] };
    }
    const tools = toGeminiTools(req.tools);
    if (tools) body.tools = tools;

    const url = `${ctx.baseUrl}/models/${req.model}:streamGenerateContent?alt=sse`;

    const res = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": ctx.apiKey,
          ...ctx.extraHeaders,
        },
        body: JSON.stringify(body),
        signal: req.signal,
      },
      { providerId: ctx.providerId },
    );

    if (!res.ok) throw await errorFromResponse(res, ctx.providerId);
    if (!res.body) {
      throw new ProviderError({
        message: "provider returned no response body",
        providerId: ctx.providerId,
      });
    }

    yield* parseGeminiStream(res.body, req.signal, this._callCounter);
  }

  async listModels(ctx: ProviderContext): Promise<ModelInfo[] | null> {
    const res = await fetchWithRetry(
      `${ctx.baseUrl}/models`,
      {
        method: "GET",
        headers: {
          "x-goog-api-key": ctx.apiKey,
          ...ctx.extraHeaders,
        },
      },
      { providerId: ctx.providerId, timeoutMs: 30_000 },
    );

    if (res.status === 404 || res.status === 405) return null;
    if (!res.ok) throw await errorFromResponse(res, ctx.providerId);

    const json = (await res.json()) as any;
    const rows: any[] = Array.isArray(json) ? json : (json.models ?? []);
    if (!Array.isArray(rows)) return null;

    const now = Date.now();
    return rows
      .filter((r) => typeof r?.name === "string")
      .map((r) => {
        // Strip the "models/" prefix to get a bare model id.
        const id: string = (r.name as string).replace(/^models\//, "");
        const raw = {
          id,
          inputTokenLimit: r.inputTokenLimit,
          outputTokenLimit: r.outputTokenLimit,
          supportedGenerationMethods: r.supportedGenerationMethods,
        };
        const { capabilities, inferred } = resolveCapabilities(id, ctx.providerId, raw);
        return {
          id,
          displayName: r.displayName ?? id,
          providerId: ctx.providerId,
          capabilities,
          fetchedAt: now,
          capabilitiesInferred: inferred,
        } satisfies ModelInfo;
      });
  }
}

function mapFinish(reason: string | null, hadToolCalls: boolean): StopReason {
  switch (reason) {
    case "STOP":
      return hadToolCalls ? "tool_use" : "end_turn";
    case "MAX_TOKENS":
      return "max_tokens";
    case "SAFETY":
      return "error";
    default:
      return hadToolCalls ? "tool_use" : "end_turn";
  }
}
