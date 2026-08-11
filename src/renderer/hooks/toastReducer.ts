/**
 * Kozum Cowork — pure toast reducer.
 *
 * Deliberately has NO React import so it can be unit-tested with plain Node.js.
 * The hook (useToasts.ts) imports from here.
 */

// ── Types ─────────────────────────────────────────────────────────────────

export type ToastSeverity = "info" | "success" | "warning" | "error";

export interface ToastActionButton {
  /** Button label, e.g. "Retry". */
  label: string;
  /** Called when the user clicks the action button. */
  onRun: () => void;
}

export interface Toast {
  id: string;
  severity: ToastSeverity;
  message: string;
  /** Timestamp (ms since epoch) when the toast was created. */
  createdAt: number;
  /** Optional inline action button (e.g. "Retry" on a send-failure toast). */
  action?: ToastActionButton;
}

export interface ToastState {
  toasts: Toast[];
}

export type ToastAction =
  | {
      type: "push";
      severity: ToastSeverity;
      message: string;
      id: string;
      createdAt: number;
      action?: ToastActionButton;
    }
  | { type: "dismiss"; id: string };

// ── Max visible cap ───────────────────────────────────────────────────────

export const TOAST_MAX_VISIBLE = 4;

// ── Pure reducer ──────────────────────────────────────────────────────────

export function toastReducer(state: ToastState, action: ToastAction): ToastState {
  switch (action.type) {
    case "push": {
      const next: Toast = {
        id: action.id,
        severity: action.severity,
        message: action.message,
        createdAt: action.createdAt,
        ...(action.action ? { action: action.action } : {}),
      };
      // Newest on top (prepend), then cap to max visible.
      // When we exceed the cap we drop the oldest (last in array) entries.
      const all = [next, ...state.toasts];
      return { toasts: all.slice(0, TOAST_MAX_VISIBLE) };
    }
    case "dismiss": {
      return { toasts: state.toasts.filter((t) => t.id !== action.id) };
    }
    default:
      return state;
  }
}
