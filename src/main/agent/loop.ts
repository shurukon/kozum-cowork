/**
 * Kozum Cowork — the agent loop.
 *
 * One user turn drives N provider round-trips: the model emits tool calls, we
 * execute them, feed the results back, and repeat until it stops asking for
 * tools or we hit the iteration ceiling.
 *
 * Design notes worth keeping in mind when editing:
 *
 *  - Tool *arguments* stream in as JSON fragments and are only parseable once
 *    the call closes. We therefore buffer fragments and parse at `tool_end`,
 *    never mid-flight.
 *
 *  - Parallel tool calls in one assistant turn are executed concurrently, but
 *    results are appended in the model's original order. Providers are strict
 *    about tool_result ordering matching tool_use ordering, and a mismatch
 *    produces a confusing 400 rather than an obvious one.
 *
 *  - Cancellation must leave the transcript valid. If we abort after the model
 *    requested tools but before we answered them, the next request would carry
 *    an unanswered tool_use and the provider would reject the whole history —
 *    so we synthesise cancellation results for every outstanding call.
 */

import type {
  AgentEvent,
  ContentBlock,
  Message,
  Mode,
  StopReason,
  ToolDefinition,
  ToolResult,
  TokenUsage,
} from "../../shared/types.ts";
import type { ProviderAdapter, ProviderContext, StreamDelta } from "../providers/adapter.ts";
import { ProviderError } from "../providers/adapter.ts";

export interface ToolExecutor {
  /** Definitions advertised to the model for this turn. */
  list(mode: Mode): ToolDefinition[];
  /**
   * Run one tool. Must resolve (never reject) — surface failures as
   * `{ ok:false }` so the model can read the error and adapt.
   */
  execute(
    name: string,
    input: unknown,
    opts: { sessionId: string; signal: AbortSignal; onProgress: (note: string) => void },
  ): Promise<ToolResult>;
}

export interface LoopOptions {
  sessionId: string;
  mode: Mode;
  adapter: ProviderAdapter;
  ctx: ProviderContext;
  model: string;
  system: string;
  /** Full prior transcript; the caller has already appended the new user turn. */
  history: Message[];
  tools: ToolExecutor;
  maxTokens: number;
  temperature: number;
  maxIterations: number;
  signal: AbortSignal;
  emit: (e: AgentEvent) => void;
}

export interface LoopResult {
  /** Messages produced this turn, to be appended to the session. */
  messages: Message[];
  usage: TokenUsage;
  stopReason: StopReason;
  iterations: number;
}

interface PendingCall {
  id: string;
  name: string;
  args: string;
  /** Preserves the model's ordering for result assembly. */
  order: number;
}

let seq = 0;
function newId(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}`;
}

const EMPTY_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 };

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0) || undefined,
    cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0) || undefined,
  };
}

export async function runAgentLoop(opts: LoopOptions): Promise<LoopResult> {
  const produced: Message[] = [];
  const working = [...opts.history];
  let total: TokenUsage = { ...EMPTY_USAGE };
  let stopReason: StopReason = "end_turn";
  let iterations = 0;

  const defs = opts.tools.list(opts.mode);

  while (iterations < opts.maxIterations) {
    iterations += 1;

    if (opts.signal.aborted) {
      stopReason = "cancelled";
      break;
    }

    const assistantId = newId("msg");
    opts.emit({
      type: "turn_start",
      sessionId: opts.sessionId,
      messageId: assistantId,
      model: opts.model,
    });

    /* ---------------------------------------------------- stream once -- */

    let text = "";
    let thinking = "";
    const calls = new Map<string, PendingCall>();
    let order = 0;
    let turnStop: StopReason = "end_turn";
    let turnUsage: TokenUsage = { ...EMPTY_USAGE };
    let streamError: Error | null = null;

    try {
      const stream = opts.adapter.stream(opts.ctx, {
        model: opts.model,
        system: opts.system,
        messages: working,
        tools: defs,
        maxTokens: opts.maxTokens,
        temperature: opts.temperature,
        signal: opts.signal,
      });

      for await (const d of stream) {
        switch (d.type) {
          case "text":
            text += d.text;
            opts.emit({
              type: "text_delta",
              sessionId: opts.sessionId,
              messageId: assistantId,
              delta: d.text,
            });
            break;

          case "thinking":
            thinking += d.text;
            opts.emit({
              type: "thinking_delta",
              sessionId: opts.sessionId,
              messageId: assistantId,
              delta: d.text,
            });
            break;

          case "tool_start":
            if (!calls.has(d.id)) {
              calls.set(d.id, { id: d.id, name: d.name, args: "", order: order++ });
            }
            break;

          case "tool_args": {
            const c = calls.get(d.id);
            if (c) c.args += d.partial;
            break;
          }

          case "tool_end":
            break; // arguments are parsed after the stream closes

          case "usage":
            turnUsage = d.usage;
            break;

          case "stop":
            turnStop = d.reason;
            break;
        }
      }
    } catch (e) {
      // An abort mid-stream is a cancellation, not a failure.
      if (opts.signal.aborted) {
        turnStop = "cancelled";
      } else {
        streamError = e instanceof Error ? e : new Error(String(e));
        turnStop = "error";
      }
    }

    total = addUsage(total, turnUsage);

    /* ------------------------------------------- record assistant turn -- */

    const blocks: ContentBlock[] = [];
    if (thinking) blocks.push({ type: "thinking", text: thinking });
    if (text) blocks.push({ type: "text", text });

    const ordered = [...calls.values()].sort((a, b) => a.order - b.order);
    for (const c of ordered) {
      blocks.push({
        type: "tool_use",
        id: c.id,
        name: c.name,
        input: parseArgs(c.args),
      });
    }

    // A completely empty assistant turn is not worth persisting, unless it
    // carries the error that explains why nothing came back.
    if (blocks.length || streamError) {
      const msg: Message = {
        id: assistantId,
        role: "assistant",
        content: blocks,
        createdAt: Date.now(),
        usage: turnUsage,
        model: opts.model,
        stopReason: turnStop,
        ...(streamError ? { error: streamError.message } : {}),
      };
      produced.push(msg);
      working.push(msg);
    }

    opts.emit({
      type: "turn_end",
      sessionId: opts.sessionId,
      messageId: assistantId,
      usage: turnUsage,
      stopReason: turnStop,
    });

    if (streamError) {
      opts.emit({
        type: "error",
        sessionId: opts.sessionId,
        message: streamError.message,
        recoverable: streamError instanceof ProviderError ? streamError.retryable : false,
      });
      stopReason = "error";
      break;
    }

    if (turnStop === "cancelled") {
      // Answer any outstanding calls so the transcript stays replayable.
      if (ordered.length) {
        produced.push(cancellationResults(ordered));
      }
      stopReason = "cancelled";
      break;
    }

    if (!ordered.length) {
      stopReason = turnStop;
      break;
    }

    /* ------------------------------------------------- execute tools --- */

    if (opts.signal.aborted) {
      produced.push(cancellationResults(ordered));
      stopReason = "cancelled";
      break;
    }

    for (const c of ordered) {
      opts.emit({
        type: "tool_start",
        sessionId: opts.sessionId,
        toolUseId: c.id,
        name: c.name,
        input: parseArgs(c.args),
      });
    }

    // Concurrent execution, ordered assembly.
    const settled = await Promise.all(
      ordered.map(async (c) => {
        const result = await runOne(opts, c);
        opts.emit({
          type: "tool_end",
          sessionId: opts.sessionId,
          toolUseId: c.id,
          result,
        });
        return { call: c, result };
      }),
    );

    const resultBlocks: ContentBlock[] = settled.map(({ call, result }) => ({
      type: "tool_result",
      toolUseId: call.id,
      isError: !result.ok,
      content: [
        { type: "text", text: result.ok ? result.content : (result.error ?? result.content) },
        ...(result.images ?? []).map(
          (im) => ({ type: "image", mimeType: im.mimeType, data: im.data }) as const,
        ),
      ],
    }));

    const resultMsg: Message = {
      id: newId("msg"),
      role: "user",
      content: resultBlocks,
      createdAt: Date.now(),
    };
    produced.push(resultMsg);
    working.push(resultMsg);

    // Loop again so the model can react to the results.
  }

  if (iterations >= opts.maxIterations && stopReason === "end_turn") {
    // Distinguish "finished" from "ran out of room to finish".
    stopReason = "max_tokens";
    opts.emit({
      type: "error",
      sessionId: opts.sessionId,
      message:
        `Stopped after ${opts.maxIterations} tool rounds without a final answer. ` +
        `Raise the iteration limit in Settings, or ask for a narrower task.`,
      recoverable: true,
    });
  }

  return { messages: produced, usage: total, stopReason, iterations };
}

/* --------------------------------------------------------------- utils -- */

/**
 * Tool arguments arrive as concatenated JSON fragments. Models occasionally
 * emit nothing (a no-arg tool) or truncate under a token limit, so a parse
 * failure must not crash the turn — it becomes a tool error the model can see
 * and correct on the next round.
 */
function parseArgs(raw: string): unknown {
  const s = raw.trim();
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return { __parseError: true, __raw: s };
  }
}

async function runOne(opts: LoopOptions, call: PendingCall): Promise<ToolResult> {
  const input = parseArgs(call.args);

  if (
    typeof input === "object" &&
    input !== null &&
    (input as { __parseError?: boolean }).__parseError
  ) {
    return {
      ok: false,
      content: "",
      error:
        `Could not parse the arguments for ${call.name} as JSON. ` +
        `Re-issue the call with valid JSON. Received: ${truncate(call.args, 300)}`,
      display: { summary: `${call.name} — malformed arguments` },
    };
  }

  try {
    return await opts.tools.execute(call.name, input, {
      sessionId: opts.sessionId,
      signal: opts.signal,
      onProgress: (note) =>
        opts.emit({
          type: "tool_progress",
          sessionId: opts.sessionId,
          toolUseId: call.id,
          note,
        }),
    });
  } catch (e) {
    // A throwing executor is a bug, but the loop must survive it.
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      content: "",
      error: `${call.name} failed: ${message}`,
      display: { summary: `${call.name} — ${message}` },
    };
  }
}

function cancellationResults(calls: PendingCall[]): Message {
  return {
    id: newId("msg"),
    role: "user",
    content: calls.map((c) => ({
      type: "tool_result" as const,
      toolUseId: c.id,
      isError: true,
      content: [{ type: "text" as const, text: "Cancelled by the user before this tool ran." }],
    })),
    createdAt: Date.now(),
  };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
