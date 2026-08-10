/**
 * Shared task status glyph (P1-3 / §10.4).
 *
 * Extracted from TaskList.tsx so PinnedTodoSlot and the RightPanel task list
 * render the identical animated status indicator. Pure presentational component.
 */

import type { AgentTask } from "@shared/types.ts";
import styles from "../components/TaskList.module.css";

export function TaskGlyph({ status }: { status: AgentTask["status"] }) {
  switch (status) {
    case "completed":
      return (
        <span className={`${styles.glyphDone} ${styles.glyphCheckDraw}`} aria-label="Completed">
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            aria-hidden="true"
            className={styles.checkSvg}
          >
            <circle cx="7" cy="7" r="6.25" stroke="currentColor" strokeWidth="1.5" />
            <path
              d="M4 7l2 2 4-4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={styles.checkPath}
            />
          </svg>
        </span>
      );
    case "failed":
      return (
        <span className={styles.glyphFailed} aria-label="Failed">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="6.25" stroke="currentColor" strokeWidth="1.5" />
            <path
              d="M9 5l-4 4M5 5l4 4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </span>
      );
    case "in_progress":
      return (
        <span className={`${styles.glyphInProgress} ${styles.glyphPulse}`} aria-label="In progress">
          <span className={`${styles.spinner} kz-spin`} />
        </span>
      );
    case "stopped":
      return (
        <span className={styles.glyphStopped} aria-label="Stopped">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="6.25" stroke="currentColor" strokeWidth="1.5" />
            <path d="M4.5 7h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </span>
      );
    default:
      // pending
      return (
        <span className={styles.glyphPending} aria-label="Pending">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="3" fill="currentColor" opacity="0.5" />
          </svg>
        </span>
      );
  }
}
