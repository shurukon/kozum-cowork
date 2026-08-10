/**
 * PermissionBanner — inline Allow/Deny prompt for a single tool invocation.
 *
 * Rendered inside a ToolCard when a `permission_request` AgentEvent is pending
 * for that card's toolUseId (or, as a degraded fallback, at the bottom of the
 * assistant message when no matching card exists). The reply goes back through
 * `bridge().sessions.reply(sessionId, requestId, ["yes"|"no"])`, matching the
 * AskBroker.registerPending(requestId) the executor awaited on the main side.
 */

import { ShieldQuestion } from "lucide-react";
import styles from "./PermissionBanner.module.css";

export interface PermissionBannerProps {
  reason: string;
  toolName: string;
  onAllow: () => void;
  onDeny: () => void;
}

export function PermissionBanner({
  reason,
  toolName,
  onAllow,
  onDeny,
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
        <button type="button" className={styles.denyBtn} onClick={onDeny}>
          Deny
        </button>
        <button type="button" className={styles.allowBtn} onClick={onAllow}>
          Allow
        </button>
      </div>
    </div>
  );
}
