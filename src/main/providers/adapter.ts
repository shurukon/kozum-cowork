/**
 * Kozum Cowork — provider adapter contract.
 *
 * One interface, five wire protocols behind it. The agent loop only ever sees
 * this contract, so adding a vendor never touches the loop.
 *
 * Streaming is modelled as an async iterable of normalised deltas rather than
 * an EventEmitter: it makes backpressure and cancellation fall out of `for
 * await`, and it means a turn is just a loop the caller can `break` out of.
 */

import type {
  ContentBlock,
  Message,
  ModelInfo,
  StopReason,
  ToolDefinition,
  TokenUsage,
} from "../../shared/types.ts";

/** Normalised streaming delta. Every adapter emits this shape. */
export type StreamDelta =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  /** A tool call has started; arguments may still be streaming in. */
  | { type: "tool_start"; id: string; name: string }
  /** Raw JSON fragment for the in-flight tool call's arguments. */
  | { type: "tool_args"; id: string; partial: string }
  | { type: "tool_end"; id: string }
  | { type: "usage"; usage: TokenUsage }
  | { type: "stop"; reason: StopReason };

export interface CompletionRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: ToolDefinition[];
  maxTokens: number;
  temperature: number;
  /** Tool selection policy for compatible providers; defaults to auto. */
  toolChoice?: "auto" | "required";
  /** Aborts the in-flight HTTP request. */
  signal: AbortSignal;
}

/** Resolved credential + endpoint for a single call. */
export interface ProviderContext {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  /** Vendor extras: Cloudflare accountId, Vertex projectId/region, etc. */
  meta: Record<string, string>;
  extraHeaders: Record<string, string>;
}

export interface ProviderAdapter {
  readonly protocol: string;

  /**
   * Stream a completion. Implementations must:
   *  - honour `signal` promptly,
   *  - always emit exactly one terminal `stop` delta,
   *  - emit `usage` when the vendor reports it.
   */
  stream(ctx: ProviderContext, req: CompletionRequest): AsyncIterable<StreamDelta>;

  /**
   * Fetch the model catalogue. Returns null when the vendor has no catalogue
   * endpoint, in which case the caller falls back to the preset's static list.
   */
  listModels(ctx: ProviderContext): Promise<ModelInfo[] | null>;
}

/* ------------------------------------------------------------- errors --- */

export class ProviderError extends Error {
  readonly status: number | undefined;
  readonly providerId: string;
  readonly retryable: boolean;
  readonly body: string | undefined;

  constructor(opts: {
    message: string;
    providerId: string;
    status?: number;
    retryable?: boolean;
    body?: string;
  }) {
    super(opts.message);
    this.name = "ProviderError";
    this.providerId = opts.providerId;
    this.status = opts.status;
    this.body = opts.body;
    this.retryable = opts.retryable ?? isRetryableStatus(opts.status);
  }
}

export function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return true; // network-level failure
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/**
 * Turn a failed Response into a ProviderError carrying the vendor's own
 * message. Vendors bury the useful text in wildly different places, so we probe
 * the known shapes before falling back to the raw body — a user staring at
 * "400 Bad Request" learns nothing, but "model X does not support tools" is
 * actionable.
 */
export async function errorFromResponse(
  res: Response,
  providerId: string,
): Promise<ProviderError> {
  let body = "";
  try {
    body = await res.text();
  } catch {
    /* body already consumed or connection died */
  }

  let message = `${res.status} ${res.statusText}`;
  try {
    const j = JSON.parse(body);
    const detail =
      j?.error?.message ??
      j?.error?.metadata?.raw ??
      j?.message ??
      j?.detail ??
      j?.error ??
      (Array.isArray(j?.errors) ? j.errors[0]?.message : undefined);
    if (typeof detail === "string" && detail.trim()) {
      message = detail.trim();
    }
  } catch {
    if (body.trim() && body.length < 400) message = body.trim();
  }

  return new ProviderError({ message, providerId, status: res.status, body });
}

/* ------------------------------------------------------------ SSE core -- */

/**
 * Parse a `text/event-stream` body into successive `data:` payloads.
 *
 * Written against the raw byte stream rather than a line-splitting helper
 * because SSE frames routinely straddle chunk boundaries mid-UTF-8-sequence;
 * a naive per-chunk split corrupts multi-byte characters. The incremental
 * TextDecoder plus a carry buffer is what makes non-Latin output survive.
 */
export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  const onAbort = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Frames are separated by a blank line; \r\n is legal too.
      let sep: number;
      while ((sep = findFrameEnd(buffer)) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^(\r?\n){1,2}/, "");

        const payload = extractData(frame);
        if (payload !== null) yield payload;
      }
    }

    // Flush any trailing frame that arrived without a terminating blank line.
    buffer += decoder.decode();
    if (buffer.trim()) {
      const payload = extractData(buffer);
      if (payload !== null) yield payload;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock?.();
  }
}

function findFrameEnd(buf: string): number {
  const a = buf.indexOf("\n\n");
  const b = buf.indexOf("\r\n\r\n");
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

/** Concatenate the `data:` lines of one frame, ignoring comments and fields. */
function extractData(frame: string): string | null {
  const lines = frame.split(/\r?\n/);
  const parts: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith(":")) continue; // heartbeat / comment
    if (line.startsWith("data:")) {
      parts.push(line.slice(5).replace(/^ /, ""));
    }
  }
  return parts.length ? parts.join("\n") : null;
}

/* ----------------------------------------------------------- fetch mid -- */

/**
 * fetch with timeout + bounded retry on transient failures.
 *
 * Retries only idempotent-by-intent calls (catalogue fetches) and 429/5xx on
 * streaming starts — never mid-stream, since a partially consumed completion
 * cannot be safely replayed.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: { providerId: string; retries?: number; timeoutMs?: number } = {
    providerId: "unknown",
  },
): Promise<Response> {
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const timer = new AbortController();
    const to = setTimeout(() => timer.abort(new Error("timeout")), timeoutMs);

    // Respect a caller-supplied signal alongside our timeout.
    const signal = init.signal
      ? anySignal([init.signal as AbortSignal, timer.signal])
      : timer.signal;

    try {
      const res = await fetch(url, { ...init, signal });
      clearTimeout(to);

      if (res.ok || !isRetryableStatus(res.status) || attempt === retries) {
        return res;
      }
      // Honour Retry-After when the vendor sets it.
      const ra = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff(attempt));
    } catch (e) {
      clearTimeout(to);
      lastErr = e;
      // A caller-initiated abort is not a failure to retry.
      if ((init.signal as AbortSignal | undefined)?.aborted) throw e;
      if (attempt === retries) break;
      await sleep(backoff(attempt));
    }
  }

  throw new ProviderError({
    message: lastErr instanceof Error ? lastErr.message : "network request failed",
    providerId: opts.providerId,
    retryable: true,
  });
}

function backoff(attempt: number): number {
  // 400ms, 1.2s, 3.6s … with jitter to avoid synchronised retries.
  const base = 400 * Math.pow(3, attempt);
  return base + Math.random() * base * 0.25;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** AbortSignal.any, with a fallback for runtimes that lack it. */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const AS = AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal };
  if (typeof AS.any === "function") return AS.any(signals);

  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ctrl.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}

/* ----------------------------------------------------------- helpers ---- */

/** Collapse our content blocks to plain text, for providers without blocks. */
export function blocksToText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
}
