/**
 * Kozum Cowork — ErrorBoundary.
 *
 * A React class component that catches render-time errors anywhere in its
 * subtree. The fallback shows a compact "Something went wrong" card with two
 * actions: "Try again" (re-mounts the subtree by toggling a key) and "Reload"
 * (full window reload).
 *
 * The `label` prop is rendered in the fallback so the user knows which surface
 * failed (e.g. "chat view", "settings"). It is also forwarded to console.error
 * for debugging.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCw, RotateCcw } from "lucide-react";
import styles from "./ErrorBoundary.module.css";

interface Props {
  /** Friendly name of the surface being guarded, e.g. "chat view". */
  label?: string;
  /** Optional custom fallback. Receives the caught error + a reset callback. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** Called when an error is caught — useful for logging. */
  onError?: (error: Error, info: ErrorInfo, label?: string) => void;
  children: ReactNode;
}

interface State {
  error: Error | null;
  /** Monotonic counter — incremented to force a re-mount of the subtree. */
  resetKey: number;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error(`[ErrorBoundary:${this.props.label ?? "unknown"}]`, error, info);
    this.props.onError?.(error, info, this.props.label);
  }

  reset = (): void => {
    this.setState((prev) => ({ error: null, resetKey: prev.resetKey + 1 }));
  };

  reload = (): void => {
    try {
      window.location.reload();
    } catch {
      /* no-op outside a browser */
    }
  };

  override render(): ReactNode {
    const { error } = this.state;
    const { label, fallback, children } = this.props;

    if (error) {
      if (fallback) {
        return fallback(error, this.reset);
      }
      return (
        <div className={styles.fallback} role="alert" aria-live="assertive">
          <AlertTriangle size={18} className={styles.icon} aria-hidden={true} />
          <div className={styles.body}>
            <p className={styles.title}>
              {label ? `Could not render ${label}` : "Something went wrong"}
            </p>
            <p className={styles.message}>{error.message || String(error)}</p>
          </div>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.tryAgainBtn}
              onClick={this.reset}
            >
              <RotateCcw size={13} />
              <span>Try again</span>
            </button>
            <button
              type="button"
              className={styles.reloadBtn}
              onClick={this.reload}
            >
              <RefreshCw size={13} />
              <span>Reload</span>
            </button>
          </div>
        </div>
      );
    }

    // Re-mount the subtree on reset by keying it.
    return <div key={this.state.resetKey} className={styles.host}>{children}</div>;
  }
}
