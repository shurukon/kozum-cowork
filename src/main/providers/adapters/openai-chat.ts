/**
 * OpenAI Chat Completions adapter.
 *
 * Serves the large majority of the catalogue: OpenAI, NVIDIA NIM, Cerebras,
 * OpenRouter, Kilo, Wafer, DeepSeek, Moonshot, MiniMax, Z.AI, Cloudflare,
 * AgentRouter and any user-supplied compatible endpoint.
 *
 * "OpenAI-compatible" is a spectrum rather than a spec, so the tolerances here
 * are deliberate: vendors disagree about whether tool-call ids arrive on the
 * first delta or the last, whether `index` is present, whether usage is
 * reported at all, and whether a lone `[DONE]` closes the stream. Each of those
 * is handled rather than assumed.
 */

import type {
  Message,
  ModelInfo,
  StopReason,
  ToolDefinition,
} from "../../../shared/types.ts";
import { resolveCapabilities, type RawCatalogueEntry } from "../capabilities.ts";
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

interface OaiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | OaiContentPart[] | null;
  tool_calls?: OaiToolCall[];
  tool_call_id?: string;
}

type OaiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface OaiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/* --------------------------------------------------------- conversion --- */

function toOaiMessages(system: string, messages: Message[]): OaiMessage[] {
  const out: OaiMessage[] = [];
  if (system.trim()) out.push({ role: "system", content: system });

  for (const m of messages) {
    if (m.role === "system") {
      out.push({ role: "system", content: textOf(m) });
      continue;
    }

    if (m.role === "user") {
      // Tool results are user-role in our model but a distinct role in OpenAI's,
      // and they must be emitted *before* any sibling user content so the
      // assistant's tool_calls are immediately followed by their answers.
      const results = m.content.filter((b) => b.type === "tool_result");
      for (const r of results) {
        if (r.type !== "tool_result") continue;
        out.push({
          role: "tool",
          tool_call_id: r.toolUseId,
          content: r.content
            .map((c) => (c.type === "text" ? c.text : "[image omitted in tool result]"))
            .join("\n"),
        });
      }

      const parts = toContentParts(m);
      if (parts.length) {
        out.push({
          role: "user",
          // Send a bare string when there is no image; a few gateways reject
          // the array form for text-only turns.
          content: parts.every((p) => p.type === "text")
            ? parts.map((p) => (p.type === "text" ? p.text : "")).join("")
            : parts,
        });
      }
      continue;
    }

    // assistant
    const toolCalls: OaiToolCall[] = m.content
      .filter((b) => b.type === "tool_use")
      .map((b) => {
        const t = b as Extract<typeof b, { type: "tool_use" }>;
        return {
          id: t.id,
          type: "function" as const,
          function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) },
        };
      });

    const text = textOf(m);
    if (text || toolCalls.length) {
      out.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    }
  }

  return out;
}

function textOf(m: Message): string {
  return m.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("");
}

function toContentParts(m: Message): OaiContentPart[] {
  const parts: OaiContentPart[] = [];
  for (const b of m.content) {
    if (b.type === "text" && b.text) {
      parts.push({ type: "text", text: b.text });
    } else if (b.type === "image") {
      parts.push({
        type: "image_url",
        image_url: { url: `data:${b.mimeType};base64,${b.data}` },
      });
    }
  }
  return parts;
}

function toOaiTools(tools: ToolDefinition[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

/* ------------------------------------------------------------ adapter --- */

export class OpenAiChatAdapter implements ProviderAdapter {
  readonly protocol = "openai-chat";

  async *stream(
    ctx: ProviderContext,
    req: CompletionRequest,
  ): AsyncIterable<StreamDelta> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: toOaiMessages(req.system, req.messages),
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      stream: true,
      // Not every vendor honours this, but those that do give us token counts
      // we would otherwise have to estimate.
      stream_options: { include_usage: true },
    };
    if (req.tools.length) {
      body.tools = toOaiTools(req.tools);
      body.tool_choice = req.toolChoice ?? "auto";
    }

    const requestInit: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.apiKey}`,
        ...ctx.extraHeaders,
      },
      body: JSON.stringify(body),
      signal: req.signal,
    };
    let res = await fetchWithRetry(
      `${ctx.baseUrl}/chat/completions`,
      requestInit,
      { providerId: ctx.providerId },
    );
    if (!res.ok) throw await errorFromResponse(res, ctx.providerId);

    // Some OpenAI-compatible gateways return HTTP 200 with a JSON error when
    // streaming is unavailable. Retry once as a normal JSON completion so the
    // agent remains usable; the rest of the app still receives normalised
    // StreamDelta events and does not need a provider-specific branch.
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      let json = (await res.json()) as any;
      if (json?.error && /streaming is not supported/i.test(String(json.error?.message ?? json.error))) {
        const fallbackBody = { ...body, stream: false };
        res = await fetchWithRetry(
          `${ctx.baseUrl}/chat/completions`,
          { ...requestInit, body: JSON.stringify(fallbackBody) },
          { providerId: ctx.providerId },
        );
        if (!res.ok) throw await errorFromResponse(res, ctx.providerId);
        json = (await res.json()) as any;
      }

      if (json?.error) {
        throw new ProviderError({
          message: json.error.message ?? String(json.error),
          providerId: ctx.providerId,
        });
      }

      const choice = json?.choices?.[0] ?? {};
      const message = choice.message ?? {};
      if (typeof message.content === "string" && message.content) {
        yield { type: "text", text: message.content };
      } else if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part?.type === "text" && part.text) yield { type: "text", text: part.text };
        }
      }

      const thinking = message.reasoning_content ?? message.reasoning ?? message.thinking;
      if (typeof thinking === "string" && thinking) yield { type: "thinking", text: thinking };

      let hadToolCalls = false;
      for (const [index, toolCall] of (message.tool_calls ?? []).entries()) {
        const id = toolCall?.id || `call_${ctx.providerId}_${index}_${Date.now()}`;
        const name = toolCall?.function?.name;
        if (!name) continue;
        hadToolCalls = true;
        yield { type: "tool_start", id, name };
        const rawArgs = toolCall.function?.arguments;
        const partial = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs ?? {});
        if (partial) yield { type: "tool_args", id, partial };
        yield { type: "tool_end", id };
      }

      if (json?.usage) {
        yield {
          type: "usage",
          usage: {
            inputTokens: json.usage.prompt_tokens ?? 0,
            outputTokens: json.usage.completion_tokens ?? 0,
            cacheReadTokens: json.usage.prompt_tokens_details?.cached_tokens,
          },
        };
      }
      yield { type: "stop", reason: mapFinish(choice.finish_reason ?? null, hadToolCalls) };
      return;
    }

    if (!res.body) {
      throw new ProviderError({
        message: "provider returned no response body",
        providerId: ctx.providerId,
      });
    }

    /*
     * Tool-call assembly.
     *
     * Deltas identify a call by `index`, but several gateways omit it when only
     * one call is in flight, and some send the id on a later delta than the
     * name. We therefore key by index-or-zero and backfill id/name whenever
     * they first appear, emitting `tool_start` exactly once per call.
     */
    const calls = new Map<
      number,
      { id: string; name: string; args: string; started: boolean }
    >();
    let finish: string | null = null;

    for await (const payload of parseSSE(res.body, req.signal)) {
      if (payload === "[DONE]") break;

      let evt: any;
      try {
        evt = JSON.parse(payload);
      } catch {
        continue; // keepalive or malformed frame
      }

      // Some vendors deliver errors inline in the stream rather than via status.
      if (evt.error) {
        throw new ProviderError({
          message: evt.error.message ?? String(evt.error),
          providerId: ctx.providerId,
        });
      }

      if (evt.usage) {
        yield {
          type: "usage",
          usage: {
            inputTokens: evt.usage.prompt_tokens ?? 0,
            outputTokens: evt.usage.completion_tokens ?? 0,
            cacheReadTokens: evt.usage.prompt_tokens_details?.cached_tokens,
          },
        };
      }

      const choice = evt.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};

      if (typeof delta.content === "string" && delta.content) {
        yield { type: "text", text: delta.content };
      } else if (Array.isArray(delta.content)) {
        // Cloudflare and a few others echo the array content shape back.
        for (const p of delta.content) {
          if (p?.type === "text" && p.text) yield { type: "text", text: p.text };
        }
      }

      // Reasoning channel, spelled differently by each vendor that has one.
      const think = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
      if (typeof think === "string" && think) {
        yield { type: "thinking", text: think };
      }

      for (const tc of delta.tool_calls ?? []) {
        const idx = typeof tc.index === "number" ? tc.index : 0;
        let slot = calls.get(idx);
        if (!slot) {
          slot = { id: "", name: "", args: "", started: false };
          calls.set(idx, slot);
        }
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;

        // Announce as soon as we know both id and name.
        if (!slot.started && slot.name) {
          if (!slot.id) slot.id = `call_${ctx.providerId}_${idx}_${Date.now()}`;
          slot.started = true;
          yield { type: "tool_start", id: slot.id, name: slot.name };
        }

        const frag = tc.function?.arguments;
        if (typeof frag === "string" && frag) {
          slot.args += frag;
          if (slot.started) yield { type: "tool_args", id: slot.id, partial: frag };
        }
      }

      if (choice.finish_reason) finish = choice.finish_reason;
    }

    for (const slot of calls.values()) {
      if (slot.started) yield { type: "tool_end", id: slot.id };
    }

    yield { type: "stop", reason: mapFinish(finish, calls.size > 0) };
  }

  async listModels(ctx: ProviderContext): Promise<ModelInfo[] | null> {
    const headers = ctx.apiKey
      ? { Authorization: `Bearer ${ctx.apiKey}`, ...ctx.extraHeaders }
      : { ...ctx.extraHeaders };

    const parse = async (res: Response): Promise<ModelInfo[] | null> => {
      if (res.status === 404 || res.status === 405) return null;
      if (!res.ok) throw await errorFromResponse(res, ctx.providerId);

      const json = (await res.json()) as any;
      const rows: RawCatalogueEntry[] = Array.isArray(json)
        ? json
        : (json.data ?? json.models ?? []);
      if (!Array.isArray(rows)) return null;

      const now = Date.now();
      return rows
        .filter((r) => typeof r?.id === "string")
        .map((r) => {
          const id = String(r.id);
          const { capabilities, inferred } = resolveCapabilities(id, ctx.providerId, r);
          return {
            id,
            displayName: r.name ?? r.display_name ?? id,
            providerId: ctx.providerId,
            capabilities,
            description: typeof r.description === "string" ? r.description : undefined,
            fetchedAt: now,
            capabilitiesInferred: inferred,
          } satisfies ModelInfo;
        });
    };

    // Primary attempt: <baseUrl>/models (OpenAI-compatible convention).
    let res = await fetchWithRetry(
      `${ctx.baseUrl}/models`,
      { method: "GET", headers },
      { providerId: ctx.providerId, timeoutMs: 30_000 },
    );

    // Fallback (W5): some gateways — AgentRouter among them — serve the
    // catalogue from the origin root without the /v1 segment while chat lives
    // under /v1. Retry once there before surfacing 401/404 to the user.
    if ((res.status === 401 || res.status === 404 || res.status === 405) && !ctx.extraHeaders["x-no-origin-fallback"]) {
      try {
        const originRoot = new URL(ctx.baseUrl).origin;
        if (`${originRoot}/models` !== `${ctx.baseUrl}/models`) {
          const alt = await fetchWithRetry(
            `${originRoot}/models`,
            { method: "GET", headers },
            { providerId: ctx.providerId, timeoutMs: 30_000 },
          );
          if (alt.ok) res = alt;
        }
      } catch { /* primary result stands */ }
    }

    return parse(res);
  }
}

function mapFinish(reason: string | null, hadToolCalls: boolean): StopReason {
  switch (reason) {
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
    case "max_tokens":
      return "max_tokens";
    case "content_filter":
      return "error";
    case "stop":
    case "eos":
    default:
      // A missing finish_reason with tool calls present still means tool_use;
      // several gateways simply never send the field.
      return hadToolCalls ? "tool_use" : "end_turn";
  }
}
