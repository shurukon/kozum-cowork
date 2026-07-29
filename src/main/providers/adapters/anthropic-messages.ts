/**
 * Anthropic Messages adapter.
 *
 * Drives the native Messages API. The most important divergence from OpenAI is
 * that `system` is a top-level field rather than a role, tool results ride in
 * user-role messages as `tool_result` blocks rather than a separate `tool`
 * role, and tools use `input_schema` instead of `parameters`.
 *
 * Streaming events come in typed pairs (block_start / block_delta / block_stop)
 * rather than choice deltas, so tool-call assembly does not need an index map —
 * the block index already identifies the in-flight call.
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

type AnthropicRole = "user" | "assistant";

interface AnthropicTextBlock {
  type: "text";
  text: string;
}

interface AnthropicImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}

interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: Array<AnthropicTextBlock | AnthropicImageBlock>;
  is_error: boolean;
}

type AnthropicBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

interface AnthropicMessage {
  role: AnthropicRole;
  content: AnthropicBlock[];
}

/* -------------------------------------------------------- conversion --- */

function toAnthropicMessages(messages: Message[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      // System messages in the history are unusual but can happen; skip them
      // since the caller handles the primary system prompt as a top-level field.
      continue;
    }

    if (m.role === "user") {
      const blocks: AnthropicBlock[] = [];

      for (const b of m.content) {
        if (b.type === "tool_result") {
          blocks.push({
            type: "tool_result",
            tool_use_id: b.toolUseId,
            content: b.content.map((c) => {
              if (c.type === "image") {
                return {
                  type: "image" as const,
                  source: { type: "base64" as const, media_type: c.mimeType, data: c.data },
                };
              }
              return { type: "text" as const, text: c.text };
            }),
            is_error: b.isError,
          });
        } else if (b.type === "text" && b.text) {
          blocks.push({ type: "text", text: b.text });
        } else if (b.type === "image") {
          blocks.push({
            type: "image",
            source: { type: "base64", media_type: b.mimeType, data: b.data },
          });
        }
      }

      if (blocks.length) out.push({ role: "user", content: blocks });
      continue;
    }

    // assistant
    const blocks: AnthropicBlock[] = [];

    for (const b of m.content) {
      if (b.type === "text" && b.text) {
        blocks.push({ type: "text", text: b.text });
      } else if (b.type === "tool_use") {
        blocks.push({
          type: "tool_use",
          id: b.id,
          name: b.name,
          input: b.input ?? {},
        });
      }
    }

    if (blocks.length) out.push({ role: "assistant", content: blocks });
  }

  return out;
}

function toAnthropicTools(tools: ToolDefinition[]) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

/* ------------------------------------------------------------ adapter --- */

export class AnthropicMessagesAdapter implements ProviderAdapter {
  readonly protocol = "anthropic-messages";

  async *stream(
    ctx: ProviderContext,
    req: CompletionRequest,
  ): AsyncIterable<StreamDelta> {
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      messages: toAnthropicMessages(req.messages),
      stream: true,
    };
    if (req.system.trim()) body.system = req.system;
    if (req.tools.length) body.tools = toAnthropicTools(req.tools);

    const res = await fetchWithRetry(
      `${ctx.baseUrl}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ctx.apiKey,
          "anthropic-version": "2023-06-01",
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
     * Block-index keyed tool-call assembly.
     *
     * `content_block_start` opens a block; for `tool_use` blocks it carries the
     * id and name. `content_block_delta` carries either `text_delta` (text
     * content), `input_json_delta` (tool argument fragments), or
     * `thinking_delta` (extended thinking). `content_block_stop` closes the
     * block and lets us emit `tool_end`.
     */
    const toolBlocks = new Map<
      number,
      { id: string; name: string; started: boolean }
    >();
    let inputUsage = 0;
    let finish: string | null = null;

    for await (const payload of parseSSE(res.body, req.signal)) {
      let evt: any;
      try {
        evt = JSON.parse(payload);
      } catch {
        continue;
      }

      const etype: string = evt.type ?? "";

      if (etype === "message_start") {
        const u = evt.message?.usage;
        if (u?.input_tokens) inputUsage = u.input_tokens;
        continue;
      }

      if (etype === "content_block_start") {
        const idx: number = evt.index ?? 0;
        const block = evt.content_block ?? {};
        if (block.type === "tool_use") {
          toolBlocks.set(idx, { id: block.id ?? "", name: block.name ?? "", started: false });
        }
        continue;
      }

      if (etype === "content_block_delta") {
        const idx: number = evt.index ?? 0;
        const delta = evt.delta ?? {};

        if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
          yield { type: "text", text: delta.text };
          continue;
        }

        if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking) {
          yield { type: "thinking", text: delta.thinking };
          continue;
        }

        if (delta.type === "input_json_delta") {
          const slot = toolBlocks.get(idx);
          if (slot) {
            // Emit tool_start on the first argument fragment since by then we
            // have id+name from content_block_start.
            if (!slot.started) {
              slot.started = true;
              yield { type: "tool_start", id: slot.id, name: slot.name };
            }
            const frag: string = delta.partial_json ?? "";
            if (frag) yield { type: "tool_args", id: slot.id, partial: frag };
          }
          continue;
        }
        continue;
      }

      if (etype === "content_block_stop") {
        const idx: number = evt.index ?? 0;
        const slot = toolBlocks.get(idx);
        if (slot && slot.started) {
          yield { type: "tool_end", id: slot.id };
        }
        continue;
      }

      if (etype === "message_delta") {
        const stopReason: string | null = evt.delta?.stop_reason ?? null;
        if (stopReason) finish = stopReason;
        const u = evt.usage;
        if (u) {
          yield {
            type: "usage",
            usage: {
              inputTokens: inputUsage,
              outputTokens: u.output_tokens ?? 0,
            },
          };
        }
        continue;
      }

      // message_stop — stream is done; nothing to emit here.
    }

    // Flush any tool blocks that never received a delta (edge case: empty args)
    for (const slot of toolBlocks.values()) {
      if (slot.started) {
        // tool_end already emitted in content_block_stop; skip.
      } else if (slot.id) {
        // A tool_use block that got no input_json_delta — emit start+end pair.
        yield { type: "tool_start", id: slot.id, name: slot.name };
        yield { type: "tool_end", id: slot.id };
      }
    }

    yield { type: "stop", reason: mapFinish(finish, toolBlocks.size > 0) };
  }

  async listModels(ctx: ProviderContext): Promise<ModelInfo[] | null> {
    const res = await fetchWithRetry(
      `${ctx.baseUrl}/models`,
      {
        method: "GET",
        headers: {
          "x-api-key": ctx.apiKey,
          "anthropic-version": "2023-06-01",
          ...ctx.extraHeaders,
        },
      },
      { providerId: ctx.providerId, timeoutMs: 30_000 },
    );

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
          displayName: r.display_name ?? r.name ?? id,
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
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    case "end_turn":
    default:
      return hadToolCalls ? "tool_use" : "end_turn";
  }
}
