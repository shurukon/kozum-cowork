/**
 * OpenAI Responses API adapter.
 *
 * The Responses API (`POST /responses`) is the successor to Chat Completions
 * and is what the official Codex CLI speaks. Its wire shape differs enough from
 * Chat Completions to warrant a separate adapter: input is called `input` (not
 * `messages`), the system prompt is `instructions`, content parts carry
 * `input_text`/`input_image` types, and function-call results go in the input
 * array as `function_call_output` items rather than as a `tool` role message.
 *
 * The streaming event types are dot-delimited strings rather than the OpenAI
 * Chat `event:` SSE field: `response.output_text.delta`, etc.
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

/* -------------------------------------------------------- wire shapes --- */

type InputTextPart = { type: "input_text"; text: string };
type InputImagePart = { type: "input_image"; image_url: string };
type InputPart = InputTextPart | InputImagePart;

interface InputItem {
  role: "user" | "assistant";
  content: InputPart[];
}

interface FunctionCallOutputItem {
  type: "function_call_output";
  call_id: string;
  output: string;
}

interface FunctionCallItem {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

type ResponsesInputItem = InputItem | FunctionCallOutputItem | FunctionCallItem;

/* -------------------------------------------------------- conversion --- */

function toResponsesInput(messages: Message[]): ResponsesInputItem[] {
  const out: ResponsesInputItem[] = [];

  for (const m of messages) {
    if (m.role === "system") continue;

    if (m.role === "user") {
      // Tool results come first as function_call_output items.
      for (const b of m.content) {
        if (b.type !== "tool_result") continue;
        out.push({
          type: "function_call_output",
          call_id: b.toolUseId,
          output: b.content
            .map((c) => (c.type === "text" ? c.text : "[image omitted in tool result]"))
            .join("\n"),
        });
      }

      const parts: InputPart[] = [];
      for (const b of m.content) {
        if (b.type === "text" && b.text) {
          parts.push({ type: "input_text", text: b.text });
        } else if (b.type === "image") {
          parts.push({
            type: "input_image",
            image_url: `data:${b.mimeType};base64,${b.data}`,
          });
        }
      }
      if (parts.length) out.push({ role: "user", content: parts });
      continue;
    }

    // assistant — emit tool calls as function_call items, text as usual.
    const parts: InputPart[] = [];
    for (const b of m.content) {
      if (b.type === "text" && b.text) {
        parts.push({ type: "input_text", text: b.text });
      } else if (b.type === "tool_use") {
        out.push({
          type: "function_call",
          call_id: b.id,
          name: b.name,
          arguments: JSON.stringify(b.input ?? {}),
        });
      }
    }
    if (parts.length) out.push({ role: "assistant", content: parts });
  }

  return out;
}

function toResponsesTools(tools: ToolDefinition[]) {
  return tools.map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  }));
}

/* ------------------------------------------------------------ adapter --- */

export class OpenAiResponsesAdapter implements ProviderAdapter {
  readonly protocol = "openai-responses";

  async *stream(
    ctx: ProviderContext,
    req: CompletionRequest,
  ): AsyncIterable<StreamDelta> {
    const body: Record<string, unknown> = {
      model: req.model,
      input: toResponsesInput(req.messages),
      stream: true,
    };
    if (req.system.trim()) body.instructions = req.system;
    if (req.tools.length) body.tools = toResponsesTools(req.tools);

    const res = await fetchWithRetry(
      `${ctx.baseUrl}/responses`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ctx.apiKey}`,
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

    /*
     * Tool-call assembly keyed by item_id.
     *
     * `response.output_item.added` announces a function_call with its name and
     * call_id. `response.function_call_arguments.delta` streams argument
     * fragments, identified by item_id. We emit `tool_start` as soon as we
     * see the output_item.added event, then stream args, then close on
     * `response.completed`.
     */
    const calls = new Map<string, { callId: string; name: string; started: boolean }>();
    let finish: string | null = null;
    let failed = false;

    for await (const payload of parseSSE(res.body, req.signal)) {
      if (payload === "[DONE]") break;

      let evt: any;
      try {
        evt = JSON.parse(payload);
      } catch {
        continue;
      }

      const etype: string = evt.type ?? "";

      if (etype === "response.failed" || etype === "response.incomplete") {
        failed = true;
        finish = etype === "response.incomplete" ? "max_tokens" : "error";
        continue;
      }

      if (etype === "response.output_item.added") {
        const item = evt.item ?? {};
        if (item.type === "function_call") {
          const itemId: string = evt.item_id ?? item.id ?? `item_${calls.size}`;
          calls.set(itemId, { callId: item.call_id ?? itemId, name: item.name ?? "", started: false });
          const slot = calls.get(itemId)!;
          slot.started = true;
          yield { type: "tool_start", id: slot.callId, name: slot.name };
        }
        continue;
      }

      if (etype === "response.output_text.delta") {
        const text: string = evt.delta ?? "";
        if (text) yield { type: "text", text };
        continue;
      }

      if (etype === "response.function_call_arguments.delta") {
        const itemId: string = evt.item_id ?? "";
        const frag: string = evt.delta ?? "";
        const slot = calls.get(itemId);
        if (slot && frag) {
          yield { type: "tool_args", id: slot.callId, partial: frag };
        }
        continue;
      }

      if (etype === "response.completed") {
        const usage = evt.response?.usage;
        if (usage) {
          yield {
            type: "usage",
            usage: {
              inputTokens: usage.input_tokens ?? 0,
              outputTokens: usage.output_tokens ?? 0,
            },
          };
        }
        // The response object carries the output items; the finish reason is
        // determined by whether tool calls were made.
        const status: string = evt.response?.status ?? "";
        if (status === "incomplete") finish = "max_tokens";
        else if (status === "failed") finish = "error";
        continue;
      }
    }

    for (const slot of calls.values()) {
      if (slot.started) yield { type: "tool_end", id: slot.callId };
    }

    if (!finish && failed) finish = "error";
    yield { type: "stop", reason: mapFinish(finish, calls.size > 0) };
  }

  async listModels(ctx: ProviderContext): Promise<ModelInfo[] | null> {
    // Not every Responses API endpoint exposes a models catalogue.
    let res: Response;
    try {
      res = await fetchWithRetry(
        `${ctx.baseUrl}/models`,
        {
          method: "GET",
          headers: ctx.apiKey
            ? { Authorization: `Bearer ${ctx.apiKey}`, ...ctx.extraHeaders }
            : { ...ctx.extraHeaders },
        },
        { providerId: ctx.providerId, timeoutMs: 30_000 },
      );
    } catch {
      return null;
    }

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
  }
}

function mapFinish(reason: string | null, hadToolCalls: boolean): StopReason {
  switch (reason) {
    case "tool_calls":
      return "tool_use";
    case "max_tokens":
    case "length":
      return "max_tokens";
    case "error":
      return "error";
    default:
      return hadToolCalls ? "tool_use" : "end_turn";
  }
}
