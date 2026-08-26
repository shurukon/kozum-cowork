/**
 * Kozum Cowork — tool registry.
 *
 * Every built-in tool registers here as a `Tool`: one definition (which drives
 * the JSON schema sent to the model, the Settings list, and the transcript
 * card) plus one handler. The registry is the sole implementation of
 * `ToolExecutor`, so the agent loop never learns what any individual tool does.
 *
 * Three cross-cutting concerns live here rather than in each tool, because
 * getting them wrong 45 times is 45 bugs:
 *
 *   1. **Input validation.** Handlers receive `unknown` from the model. The
 *      registry checks required properties and coerces primitives against the
 *      declared schema before dispatch, so a handler never sees a missing path.
 *
 *   2. **No capability gating.** (R5) Every tool runs for every model — the
 *      former `requiresVision` refusal was removed by product decision.
 *
 *   3. **Workspace confinement.** Path-taking tools resolve against the
 *      session's working folder and refuse to escape it unless the session is
 *      explicitly unscoped. Symlinks are resolved before the check, otherwise a
 *      link inside the folder is a trivial escape hatch.
 */

import type {
  Mode,
  ModelCapabilities,
  ToolDefinition,
  ToolResult,
} from "../../shared/types.ts";

export interface ToolContext {
  sessionId: string;
  mode: Mode;
  /** Absolute path the session is scoped to, or null when unscoped. */
  workingFolder: string | null;
  /** Directory for scratch output the user did not explicitly ask for. */
  outputsDir: string;
  capabilities: ModelCapabilities;
  modelId: string;
  providerId: string;
  signal: AbortSignal;
  onProgress: (note: string) => void;
  /** Emit an inline question prompt and suspend until the UI replies. */
  onQuestion?: (payload: {
    requestId: string;
    question: string;
    options: Array<{ label: string; value: string }>;
    multiSelect: boolean;
    allowFreeform?: boolean;
  }) => void;
  /** Open a target in the user-facing preview panel (W4 preview_open). */
  onPreviewOpen?: (
    target: { kind: "file"; path: string } | { kind: "url"; url: string },
  ) => void;
}

export type ToolHandler = (
  input: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<ToolResult>;

export interface Tool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

/* ------------------------------------------------------------ results --- */

export function ok(
  content: string,
  display?: ToolResult["display"],
  images?: ToolResult["images"],
): ToolResult {
  return { ok: true, content, ...(display ? { display } : {}), ...(images ? { images } : {}) };
}

export function fail(error: string, summary?: string): ToolResult {
  return {
    ok: false,
    content: "",
    error,
    display: { summary: summary ?? error.split("\n")[0]!.slice(0, 160) },
  };
}

/* ----------------------------------------------------------- registry --- */

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): this {
    if (this.tools.has(tool.definition.name)) {
      throw new Error(`duplicate tool registration: ${tool.definition.name}`);
    }
    this.tools.set(tool.definition.name, tool);
    return this;
  }

  registerAll(tools: Tool[]): this {
    for (const t of tools) this.register(t);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()].sort();
  }

  /** Definitions advertised to the model, filtered by mode and opt-outs. */
  list(mode: Mode, enabled?: string[] | null): ToolDefinition[] {
    const out: ToolDefinition[] = [];
    for (const t of this.tools.values()) {
      if (!t.definition.modes.includes(mode)) continue;
      if (enabled && !enabled.includes(t.definition.name)) continue;
      out.push(t.definition);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async execute(
    name: string,
    rawInput: unknown,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      const close = suggest(name, this.names());
      return fail(
        `Unknown tool "${name}".` + (close ? ` Did you mean "${close}"?` : ""),
      );
    }

    const def = tool.definition;

    if (!def.modes.includes(ctx.mode)) {
      return fail(`"${name}" is not available in ${ctx.mode} mode.`);
    }

    // R5: the requiresVision/vision==="no" hard gate was removed by product
    // decision — EVERY model may attempt ANY tool, preview and screenshots
    // included, with no exceptions. A text-only model simply gets a degraded
    // experience; the provider adjudicates image payloads itself.

    if (ctx.signal.aborted) return fail("Cancelled before this tool ran.");

    const parsed = coerceInput(rawInput, def);
    if ("error" in parsed) return fail(parsed.error, `${name} — invalid input`);

    try {
      return await tool.handler(parsed.value, ctx);
    } catch (e) {
      // Handlers are expected to return failures, not throw. Surviving a throw
      // matters anyway: the alternative is killing the whole turn.
      return fail(describeError(e), `${name} failed`);
    }
  }
}

/* -------------------------------------------------------- validation ---- */

/**
 * Validate and lightly coerce model-supplied arguments.
 *
 * Models routinely send `"true"` for booleans and `"3"` for numbers, especially
 * smaller ones. Rejecting those outright wastes a whole round-trip to teach the
 * model something we can simply accept, so string forms of primitives are
 * coerced. Genuinely wrong shapes still fail loudly.
 */
function coerceInput(
  raw: unknown,
  def: ToolDefinition,
): { value: Record<string, unknown> } | { error: string } {
  if (raw === null || raw === undefined) {
    if ((def.inputSchema.required ?? []).length === 0) return { value: {} };
    return { error: `${def.name} requires arguments but received none.` };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { error: `${def.name} expects a JSON object, received ${typeof raw}.` };
  }

  const input = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const props = def.inputSchema.properties;

  for (const [key, spec] of Object.entries(props)) {
    if (!(key in input) || input[key] === null || input[key] === undefined) continue;
    const v = input[key];

    switch (spec.type) {
      case "string":
        out[key] = typeof v === "string" ? v : String(v);
        break;

      case "number":
      case "integer": {
        const n = typeof v === "number" ? v : Number(String(v).trim());
        if (!Number.isFinite(n)) {
          return { error: `${def.name}: "${key}" must be a number, got ${JSON.stringify(v)}.` };
        }
        out[key] = spec.type === "integer" ? Math.trunc(n) : n;
        break;
      }

      case "boolean":
        if (typeof v === "boolean") out[key] = v;
        else if (v === "true" || v === "1" || v === 1) out[key] = true;
        else if (v === "false" || v === "0" || v === 0) out[key] = false;
        else {
          return { error: `${def.name}: "${key}" must be a boolean, got ${JSON.stringify(v)}.` };
        }
        break;

      case "array": {
        let arr: unknown[];
        if (Array.isArray(v)) {
          arr = v;
        } else if (typeof v === "string" || typeof v === "number") {
          // A single value where a list is expected is a common model slip.
          arr = [v];
        } else {
          return { error: `${def.name}: "${key}" must be an array.` };
        }
        // L13: validate each item against items.type when declared.
        const itemType = spec.items?.type;
        if (itemType) {
          for (let idx = 0; idx < arr.length; idx++) {
            const item = arr[idx];
            // eslint-disable-next-line valid-typeof
            if (typeof item !== itemType) {
              return {
                error:
                  `${def.name}: "${key}[${idx}]" must be of type ${itemType}, ` +
                  `got ${typeof item}.`,
              };
            }
          }
        }
        out[key] = arr;
        break;
      }

      case "object":
        if (typeof v === "object" && !Array.isArray(v)) out[key] = v;
        else if (typeof v === "string") {
          try {
            out[key] = JSON.parse(v);
          } catch {
            return { error: `${def.name}: "${key}" must be an object.` };
          }
        } else {
          return { error: `${def.name}: "${key}" must be an object.` };
        }
        break;
    }

    if (spec.enum && typeof out[key] === "string" && !spec.enum.includes(out[key] as string)) {
      return {
        error:
          `${def.name}: "${key}" must be one of ${spec.enum.join(", ")}, ` +
          `got "${String(out[key])}".`,
      };
    }
  }

  const missing = (def.inputSchema.required ?? []).filter(
    (k) => out[k] === undefined || out[k] === "",
  );
  if (missing.length) {
    return {
      error:
        `${def.name} is missing required argument${missing.length > 1 ? "s" : ""}: ` +
        `${missing.join(", ")}.`,
    };
  }

  // Apply declared defaults so handlers can rely on them being present.
  for (const [key, spec] of Object.entries(props)) {
    if (out[key] === undefined && spec.default !== undefined) out[key] = spec.default;
  }

  return { value: out };
}

/* ----------------------------------------------------------- helpers ---- */

export function describeError(e: unknown): string {
  if (e instanceof Error) {
    // Node's fs errors carry the useful part in `code`, and the raw `message`
    // already includes the path, so surface both without duplicating.
    const code = (e as NodeJS.ErrnoException).code;
    return code ? `${e.message} (${code})` : e.message;
  }
  return String(e);
}

/** Levenshtein-lite nearest name, for "did you mean" on tool typos. */
function suggest(name: string, candidates: string[]): string | null {
  let best: string | null = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    const d = distance(name, c);
    if (d < bestScore) {
      bestScore = d;
      best = c;
    }
  }
  return bestScore <= Math.max(2, Math.floor(name.length / 3)) ? best : null;
}

function distance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i, ...Array<number>(n).fill(0)];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[n]!;
}
