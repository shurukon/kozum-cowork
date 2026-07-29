/**
 * Kozum Cowork — toast notification component.
 *
 * Renders a stacked list of toasts in the bottom-right corner.
 * Severity-aware: info / success / warning / error, each with its own
 * coloured left edge and matching icon from the token palette.
 *
 * Auto-dismisses after 5s (errors persist until manually dismissed).
 * Hover pauses the auto-dismiss timer. Enter/exit animations use kz-rise
 * and a slide-right fade; respects [data-motion="reduced"].
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Info, CheckCircle, AlertTriangle, XCircle, X } from "lucide-react";
import type { Toast as ToastType, ToastSeverity } from "../hooks/useToasts.ts";
import styles from "./Toast.module.css";

// ── Constants ─────────────────────────────────────────────────────────────

const AUTO_DISMISS_MS = 5000;

// ── Icon map ──────────────────────────────────────────────────────────────

const ICONS: Record<ToastSeverity, typeof Info> = {
  info: Info,
  success: CheckCircle,
  warning: AlertTriangle,
  error: XCircle,
};

const ICON_CLASS: Record<ToastSeverity, string> = {
  info: styles.iconInfo,
  success: styles.iconSuccess,
  warning: styles.iconWarning,
  error: styles.iconError,
};

const TOAST_CLASS: Record<ToastSeverity, string> = {
  info: styles.toastInfo,
  success: styles.toastSuccess,
  warning: styles.toastWarning,
  error: styles.toastError,
};

// ── Single toast item ─────────────────────────────────────────────────────

interface ItemProps {
  toast: ToastType;
  onDismiss: (id: string) => void;
}

function ToastItem({ toast, onDismiss }: ItemProps) {
  const [exiting, setExiting] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function startTimer() {
    if (toast.severity === "error") return; // errors persist
    timerRef.current = setTimeout(() => {
      setExiting(true);
    }, AUTO_DISMISS_MS);
  }

  function clearTimer() {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  useEffect(() => {
    startTimer();
    return clearTimer;
  }, []);

  function handleAnimationEnd() {
    if (exiting) onDismiss(toast.id);
  }

  const Icon = ICONS[toast.severity];

  return (
    <div
      role="alert"
      aria-live={toast.severity === "error" ? "assertive" : "polite"}
      className={`${styles.toast} ${TOAST_CLASS[toast.severity]} ${exiting ? styles.toastExiting : ""}`}
      onMouseEnter={clearTimer}
      onMouseLeave={startTimer}
      onAnimationEnd={handleAnimationEnd}
    >
      <span className={`${styles.icon} ${ICON_CLASS[toast.severity]}`}>
        <Icon size={15} aria-hidden={true} />
      </span>
      <div className={styles.body}>
        <p className={styles.message}>{toast.message}</p>
      </div>
      <button
        className={styles.close}
        onClick={() => {
          clearTimer();
          setExiting(true);
        }}
        aria-label="Dismiss notification"
      >
        <X size={13} />
      </button>
    </div>
  );
}

// ── Region (portal) ───────────────────────────────────────────────────────

interface RegionProps {
  toasts: ToastType[];
  onDismiss: (id: string) => void;
}

export function ToastRegion({ toasts, onDismiss }: RegionProps) {
  if (toasts.length === 0) return null;
  return createPortal(
    <div
      className={styles.region}
      aria-label="Notifications"
      role="region"
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>,
    document.body,
  );
}
