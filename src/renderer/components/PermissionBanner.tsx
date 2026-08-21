/**
 * PermissionBanner — inline permission prompt for a single tool invocation.
 *
 * The decision is sent back through AskBroker and is scoped by the backend:
 * allow_once applies to this invocation, while allow_always is remembered only
 * for the current session.
 */

import { ShieldQuestion } from "lucide-react";
import styles from "./PermissionBanner.module.css";

export type PermissionDecision = "allow_once" | "allow_always" | "deny";

export interface PermissionBannerProps {
  reason: string;
  toolName: string;
  onDecision: (decision: PermissionDecision) => void;
}

export function PermissionBanner({
  reason,
  toolName,
  onDecision,
}: PermissionBannerProps) {
  return (
    <div className={styles.root} role="alert" aria-live="assertive">
      <span className={styles.icon} aria-hidden="true">
        <ShieldQuestion size={14} />
      </span>
      <div className={styles.body}>
        <p className={styles.title}>
          <span className={styles.toolName}>{toolName}</span> needs your approval
        </p>
        {reason ? <p className={styles.reason}>{reason}</p> : null}
      </div>
      <div className={styles.actions}>
        <button type="button" className={styles.denyBtn} onClick={() => onDecision("deny")}>
          Deny
        </button>
        <button type="button" className={styles.allowBtn} onClick={() => onDecision("allow_once")}>
          Allow once
        </button>
        <button type="button" className={styles.allowBtn} onClick={() => onDecision("allow_always")}>
          Allow always
        </button>
      </div>
    </div>
  );
}
