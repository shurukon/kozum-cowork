/**
 * SubagentCard — live progress for a single subagent run (P1-1 / §10.3).
 *
 * Renders a pill-shaped glass card with:
 *  - Header: subagent name + status pulse while running.
 *  - Body: progress bar + last few progress notes.
 *  - Footer: collapsed into "Completed in Xs" once the run ends.
 *
 * The card stays in the RightPanel "Subagents" section after completion so the
 * user can review the final result; collapse/expand is purely visual.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SubagentView } from "../store/sessionTypes.ts";
import { bridge } from "../bridge.ts";
import styles from "./SubagentCard.module.css";

export interface SubagentCardProps {
  view: SubagentView;
}

function relativeTime(startedAt: number, endedAt?: number): string {
  const end = endedAt ?? Date.now();
  const ms = Math.max(0, end - startedAt);
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m ${rs}s`;
}

export function SubagentCard({ view }: SubagentCardProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const isRunning = view.status === "running";
  const progressPct = Math.round((view.progress ?? 0) * 100);
  const recentNotes = view.emitHistory.slice(-3);

  const statusLabel = isRunning
    ? `${t("subagent.running")} · ${relativeTime(view.startedAt)}`
    : view.status === "completed"
      ? `${t("subagent.completed")} · ${relativeTime(view.startedAt, view.endedAt)}`
      : view.status === "failed"
        ? t("subagent.failed")
        : t("subagent.cancelled");

  async function handleCancel(e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await bridge().subagents.cancel(view.id);
    } catch {
      /* best-effort; the card will update on the next subagent_end event */
    }
  }

  return (
    <div
      className={`${styles.card} kz-glass ${isRunning ? styles.running : ""}`}
      data-subagent-status={view.status}
    >
      <button
        type="button"
        className={styles.header}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        {isRunning ? <span className={styles.pulse} aria-hidden={true} /> : (
          <span className={styles.dot} aria-hidden={true} />
        )}
        <span className={styles.name}>{view.name}</span>
        <span className={styles.meta}>{statusLabel}</span>
        {isRunning && (
          <button
            type="button"
            className={styles.cancelBtn}
            onClick={handleCancel}
            aria-label={t("subagent.cancel")}
            title={t("subagent.cancel")}
          >
            <X size={11} />
          </button>
        )}
        {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
      </button>

      {isRunning && (
        <div className={styles.progress} aria-label={t("subagent.progress")}>
          <div className={styles.progressBar} style={{ width: `${progressPct}%` }} />
        </div>
      )}

      {expanded && (
        <div className={styles.body}>
          {recentNotes.length > 0 && (
            <ul className={styles.notes}>
              {recentNotes.map((n, i) => (
                <li
                  key={i}
                  className={`${styles.note} kz-anim-slide-right`}
                  style={{ animationDelay: `${i * 40}ms` }}
                >
                  {n.note}
                </li>
              ))}
            </ul>
          )}
          {!isRunning && view.result && (
            <pre className={styles.result}>{view.result.slice(0, 600)}</pre>
          )}
          {!isRunning && view.error && (
            <p className={styles.error}>{view.error}</p>
          )}
        </div>
      )}
    </div>
  );
}
