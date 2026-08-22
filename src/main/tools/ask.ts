/**
 * Ask-user tools — suspend the agent turn until the user answers.
 *
 * AskBroker holds a map of pending promises. The tool handler creates a promise,
 * emits a "question" AgentEvent, and awaits the promise. The UI layer calls
 * AskBroker.resolve(requestId, values) or AskBroker.reject(requestId, reason)
 * to unblock the handler. Aborting ctx.signal rejects cleanly instead of
 * hanging forever.
 */

import type { Tool } from "./registry.ts";
import { ok, fail } from "./registry.ts";

/* ----------------------------------------------------------- AskBroker ---- */

export interface AskPayload {
  question: string;
  options: Array<{ label: string; value: string }>;
  multiSelect: boolean;
  allowFreeform?: boolean;
}

export class AskBroker {
  private pending = new Map<
    string,
    { sessionId: string; resolve: (values: string[]) => void; reject: (reason: unknown) => void }
  >();

  /** Returns a Promise that resolves when the UI calls resolve(requestId, values). */
  ask(sessionId: string, _payload: AskPayload): { requestId: string; promise: Promise<string[]> } {
    const requestId = `ask_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;

    const promise = new Promise<string[]>((res, rej) => {
      this.pending.set(requestId, { sessionId, resolve: res, reject: rej });
    });

    return { requestId, promise };
  }

  /**
   * Pre-register a pending request with a caller-supplied requestId.
   *
   * Used by the per-tool permission flow: the executor allocates an id, emits a
   * `permission_request` AgentEvent with that id, and the UI's reply routes to
   * `AskBroker.resolve(requestId, ...)` against the SAME id. `ask()` cannot be
   * used there because it generates a fresh id that would never match the id
   * emitted to the UI.
   */
  registerPending(requestId: string, _payload: AskPayload, sessionId = ""): Promise<string[]> {
    return new Promise<string[]>((res, rej) => {
      this.pending.set(requestId, { sessionId, resolve: res, reject: rej });
    });
  }

  resolve(requestId: string, values: string[], sessionId?: string): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    if (sessionId !== undefined && entry.sessionId !== sessionId) return false;
    this.pending.delete(requestId);
    entry.resolve(values);
    return true;
  }

  reject(requestId: string, reason: string, sessionId?: string): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    if (sessionId !== undefined && entry.sessionId !== sessionId) return false;
    this.pending.delete(requestId);
    entry.reject(new Error(reason));
    return true;
  }

  /** Clean up all pending requests owned by one session during teardown. */
  rejectAllForSession(sessionId: string, reason: string): void {
    for (const [id, entry] of this.pending) {
      if (entry.sessionId !== sessionId) continue;
      entry.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  /** Clean up every pending request, reserved for full application shutdown. */
  rejectAll(reason: string): void {
    for (const [id, entry] of this.pending) {
      entry.reject(new Error(reason));
      this.pending.delete(id);
    }
  }
}

/* ----------------------------------------------------------- ask tools ---- */

export function makeAskTools(broker: AskBroker): Tool[] {
  return [
    {
      definition: {
        name: "ask_user_question",
        title: "Ask User",
        description:
          "Suspend the current turn and present a question to the user with a set of " +
          "selectable options. The agent waits until the user picks an answer. Use when " +
          "you need clarification, a decision, or confirmation before proceeding. " +
          "Returns the chosen option value(s) as text.",
        inputSchema: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "The question to show the user. Be specific and concise.",
            },
            options: {
              type: "array",
              description:
                "Optional array of choices. Each must have a `label` (display text) and `value` (returned string). Omit it when allowFreeform is true.",
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  value: { type: "string" },
                },
              },
            },
            multiSelect: {
              type: "boolean",
              description: "Allow the user to pick multiple options. Default false.",
              default: false,
            },
            allowFreeform: {
              type: "boolean",
              description: "Show a text field so the user can type an answer. Default false.",
              default: false,
            },
          },
          required: ["question"],
        },
        icon: "circle-help",
        group: "agent",
        modes: ["cowork", "code"],
      },
      async handler(input, ctx) {
        const question = String(input["question"] ?? "").trim();
        if (!question) return fail("question is required.");

        const allowFreeform = input["allowFreeform"] === true;
        const rawOptions = input["options"];
        if (!Array.isArray(rawOptions) && !allowFreeform) {
          return fail("options must be a non-empty array unless allowFreeform is true.");
        }

        const options = (Array.isArray(rawOptions) ? rawOptions : [])
          .filter(
            (o): o is { label: string; value: string } =>
              typeof o === "object" &&
              o !== null &&
              typeof (o as Record<string, unknown>)["label"] === "string" &&
              typeof (o as Record<string, unknown>)["value"] === "string",
          )
          .map((o) => ({ label: o.label, value: o.value }));

        if (options.length === 0 && !allowFreeform) {
          return fail("options must contain objects with label (string) and value (string).");
        }

        const multiSelect =
          typeof input["multiSelect"] === "boolean" ? input["multiSelect"] : false;

        const { requestId, promise } = broker.ask(ctx.sessionId, {
          question,
          options,
          multiSelect,
          allowFreeform,
        });

        // Emit a structured question event so the renderer can render an inline
        // prompt and the user can answer without leaving the chat.
        ctx.onQuestion?.({ requestId, question, options, multiSelect, allowFreeform });

        // Race against abort.
        const abortPromise = new Promise<never>((_res, rej) => {
          if (ctx.signal.aborted) {
            rej(new Error("Cancelled"));
            return;
          }
          ctx.signal.addEventListener("abort", () => rej(new Error("Cancelled")), { once: true });
        });

        let values: string[];
        try {
          values = await Promise.race([promise, abortPromise]);
        } catch (e) {
          broker.reject(requestId, "Cancelled by abort signal.");
          return fail(e instanceof Error ? e.message : "Cancelled.");
        }

        return ok(
          values.join(", "),
          { summary: `User answered: ${values.join(", ")}` },
        );
      },
    },
  ];
}

export const defaultBroker = new AskBroker();
export const askTools: Tool[] = makeAskTools(defaultBroker);
