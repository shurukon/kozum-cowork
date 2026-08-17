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
import { randomUUID } from "node:crypto";
import type { ProviderAdapter, ProviderContext } from "../providers/adapter.ts";
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
  /** Maximum wall-clock time for one tool call before it is aborted. */
  toolTimeoutMs?: number;
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
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new Error("Cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

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

  // Every event emitted for this turn carries a single runId so the session store
  // can persist a sidecar of the turn and the renderer can reattach after a
  // refresh (P1-7 / §9.2). The wrapper injects it; call sites use `emit(...)`.
  const runId = randomUUID();
  let eventSeq = 0;
  const emit = (e: AgentEvent): void => {
    const eventId = e.eventId ?? `${runId}:${++eventSeq}`;
    opts.emit({ ...e, runId, eventId });
  };

  const defs = opts.tools.list(opts.mode);

  while (iterations < opts.maxIterations) {
    iterations += 1;

    if (opts.signal.aborted) {
      stopReason = "cancelled";
      break;
    }

    const assistantId = newId("msg");
    emit({
      type: "turn_start",
      mode: opts.mode,
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
    let providerAttempts = 0;

    // Retry only a clean, pre-output provider failure. Retrying after visible
    // deltas would duplicate text/tool calls in the transcript, which is worse
    // than surfacing a recoverable error to the user.
    while (true) {
      try {
        const stream = opts.adapter.stream(opts.ctx, {
          model: opts.model,
          system: opts.system,
          messages: working,
          tools: defs,
          maxTokens: opts.maxTokens,
          temperature: opts.temperature,
          toolChoice: shouldRequireToolChoice(opts.mode, iterations, defs, working) ? "required" : "auto",
          signal: opts.signal,
        });

        for await (const d of stream) {
          switch (d.type) {
            case "text":
              text += d.text;
              emit({
                type: "text_delta",
                mode: opts.mode,
                sessionId: opts.sessionId,
                messageId: assistantId,
                delta: d.text,
              });
              break;

            case "thinking":
              thinking += d.text;
              emit({
                type: "thinking_delta",
                mode: opts.mode,
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
        break;
      } catch (e) {
        // An abort mid-stream is a cancellation, not a failure.
        if (opts.signal.aborted) {
          turnStop = "cancelled";
          break;
        }

        const candidate = e instanceof Error ? e : new Error(String(e));
        const canRetry =
          candidate instanceof ProviderError &&
          candidate.retryable &&
          !text &&
          !thinking &&
          calls.size === 0 &&
          providerAttempts < 2;

        if (canRetry) {
          providerAttempts += 1;
          const delayMs = 500 * 2 ** (providerAttempts - 1);
          const note = `Provider connection interrupted. Retrying (${providerAttempts}/2)…`;
          thinking += note;
          emit({
            type: "thinking_delta",
            mode: opts.mode,
            sessionId: opts.sessionId,
            messageId: assistantId,
            delta: note,
          });
          try {
            await sleepWithAbort(delayMs, opts.signal);
          } catch {
            turnStop = "cancelled";
            break;
          }
          continue;
        }

        streamError = candidate;
        turnStop = "error";
        // Mirror to stdout so failures are visible in `npm run dev` logs even
        // when the renderer's IPC handler is misrouted or unwired.
        console.error(`[${opts.mode}] agent stream error:`, streamError.message);
        break;
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

    emit({
      type: "turn_end",
      mode: opts.mode,
      sessionId: opts.sessionId,
      messageId: assistantId,
      usage: turnUsage,
      stopReason: turnStop,
    });

    // If the turn ended without producing tool results (error OR cancellation
    // after tool_use blocks were already pushed), synthesise error results now
    // so the transcript stays replayable.  The provider rejects any history
    // that carries an unanswered tool_use, so this MUST happen before we break.
    if (ordered.length && (streamError || turnStop === "cancelled")) {
      produced.push(
        streamError
          ? errorResults(ordered, streamError.message)
          : cancellationResults(ordered),
      );
    }

    if (streamError) {
      emit({
        type: "error",
        mode: opts.mode,
        sessionId: opts.sessionId,
        message: streamError.message,
        recoverable: streamError instanceof ProviderError ? streamError.retryable : false,
      });
      stopReason = "error";
      break;
    }

    if (turnStop === "cancelled") {
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
      emit({
        type: "tool_start",
        mode: opts.mode,
        sessionId: opts.sessionId,
        toolUseId: c.id,
        name: c.name,
        input: parseArgs(c.args),
      });
    }

    // Concurrent execution, ordered assembly.
    const settled = await Promise.all(
      ordered.map(async (c) => {
        const result = await runOne(opts, c, emit, opts.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS);
        emit({
          type: "tool_end",
          mode: opts.mode,
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
    emit({
      type: "error",
      mode: opts.mode,
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
function shouldRequireToolChoice(
  mode: Mode,
  iteration: number,
  defs: ToolDefinition[],
  history: Message[],
): boolean {
  if (mode !== "cowork" || iteration !== 1 || defs.length === 0) return false;
  const latestUserText = [...history]
    .reverse()
    .find((m) => m.role === "user")
    ?.content
    .filter((block) => block.type === "text")
    .map((block) => (block.type === "text" ? block.text : ""))
    .join(" ")
    .toLowerCase() ?? "";
  return /\b(create|write|edit|save|open|preview|run|execute|build|generate|download|search|read|delete|move|shell|server|html|file)\b|أنشئ|اصنع|اكتب|عدّل|احفظ|افتح|شغّل|نفّذ|ملف|معاينة|خادم|ابحث|اقرأ|احذف/.test(latestUserText);
}

function parseArgs(raw: string): unknown {
  const s = raw.trim();
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return { __parseError: true, __raw: s };
  }
}

async function runOne(
  opts: LoopOptions,
  call: PendingCall,
  emit: (e: AgentEvent) => void,
  timeoutMs: number,
): Promise<ToolResult> {
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

  const toolController = new AbortController();
  const forwardAbort = () => toolController.abort();
  opts.signal.addEventListener("abort", forwardAbort, { once: true });
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const execution = opts.tools.execute(call.name, input, {
      sessionId: opts.sessionId,
      signal: toolController.signal,
      onProgress: (note) =>
        emit({
          type: "tool_progress",
          mode: opts.mode,
          sessionId: opts.sessionId,
          toolUseId: call.id,
          note,
        }),
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        toolController.abort();
        reject(new Error(`Tool timed out after ${Math.ceil(timeoutMs / 1000)}s.`));
      }, timeoutMs);
    });
    return await Promise.race([execution, timeout]);
  } catch (e) {
    if (opts.signal.aborted) {
      return {
        ok: false,
        content: "",
        error: `${call.name} cancelled before completion.`,
        display: { summary: `${call.name} — cancelled` },
      };
    }
    if (timedOut) {
      return {
        ok: false,
        content: "",
        error:
          `${call.name} exceeded the ${Math.ceil(timeoutMs / 1000)}s tool timeout. ` +
          "The tool was aborted; retry with a smaller scope or a more specific path.",
        display: { summary: `${call.name} — timed out` },
      };
    }
    // A throwing executor is a bug, but the loop must survive it.
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      content: "",
      error: `${call.name} failed: ${message}`,
      display: { summary: `${call.name} — ${message}` },
    };
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal.removeEventListener("abort", forwardAbort);
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

function errorResults(calls: PendingCall[], errorMessage: string): Message {
  return {
    id: newId("msg"),
    role: "user",
    content: calls.map((c) => ({
      type: "tool_result" as const,
      toolUseId: c.id,
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `Provider stream error before this tool ran: ${errorMessage}`,
        },
      ],
    })),
    createdAt: Date.now(),
  };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
