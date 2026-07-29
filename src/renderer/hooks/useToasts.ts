/**
 * Kozum Cowork — toast hook.
 *
 * Wraps the pure toastReducer (toastReducer.ts) in React's useReducer.
 * Re-exports all types so consumers only need to import from useToasts.ts.
 */

import { useCallback, useReducer } from "react";
import {
  toastReducer,
  TOAST_MAX_VISIBLE,
  type Toast,
  type ToastSeverity,
  type ToastState,
  type ToastAction,
} from "./toastReducer.ts";

// Re-export everything so callers don't need two imports
export {
  toastReducer,
  TOAST_MAX_VISIBLE,
  type Toast,
  type ToastSeverity,
  type ToastState,
  type ToastAction,
};

// ── Hook ──────────────────────────────────────────────────────────────────

export interface UseToastsReturn {
  toasts: Toast[];
  push: (severity: ToastSeverity, message: string) => void;
  dismiss: (id: string) => void;
}

export function useToasts(): UseToastsReturn {
  const [state, dispatch] = useReducer(toastReducer, { toasts: [] });

  const push = useCallback((severity: ToastSeverity, message: string) => {
    dispatch({
      type: "push",
      severity,
      message,
      id: `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      createdAt: Date.now(),
    });
  }, []);

  const dismiss = useCallback((id: string) => {
    dispatch({ type: "dismiss", id });
  }, []);

  return { toasts: state.toasts, push, dismiss };
}
