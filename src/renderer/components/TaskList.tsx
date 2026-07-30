/**
 * Kozum Cowork — TaskList component.
 *
 * Live task state extracted from RightPanel so it can be reused or tested in
 * isolation. Each task shows an animated status glyph: pending (dim dot),
 * in_progress (spinner + pulse), completed (check that draws in once), failed
 * (error mark), stopped (minus circle).
 */

import type { AgentTask } from "@shared/types.ts";
import styles from "./TaskList.module.css";

// ── Status glyph ───────────────────────────────────────────────────────────

interface GlyphProps {
  status: AgentTask["status"];
}

function TaskGlyph({ status }: GlyphProps) {
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

// ── Count summary ──────────────────────────────────────────────────────────

function CountSummary({ tasks }: { tasks: AgentTask[] }) {
  const done = tasks.filter((t) => t.status === "completed").length;
  const total = tasks.length;
  if (total === 0) return null;
  return (
    <p className={styles.summary}>
      {done} of {total} done
    </p>
  );
}

// ── Props ──────────────────────────────────────────────────────────────────

export interface TaskListProps {
  tasks: AgentTask[];
}

// ── Component ─────────────────────────────────────────────────────────────

export function TaskList({ tasks }: TaskListProps) {
  if (tasks.length === 0) {
    return <p className={styles.empty}>No tasks yet.</p>;
  }

  return (
    <div className={styles.root}>
      <CountSummary tasks={tasks} />
      <ul className={styles.list}>
        {tasks.map((task) => (
          <li
            key={task.id}
            className={`${styles.item} kz-anim-rise`}
            data-status={task.status}
          >
            <TaskGlyph status={task.status} />
            <div className={styles.info}>
              <span className={styles.subject}>{task.subject}</span>
              {task.description && (
                <span className={styles.desc}>{task.description}</span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
