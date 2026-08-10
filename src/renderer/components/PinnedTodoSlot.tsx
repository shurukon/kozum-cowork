/**
 * PinnedTodoSlot — the live task list pinned above the composer (P1-3 / §5.2).
 *
 * Renders only when there are tasks AND the list is still "live" (some entry is
 * not completed, or it was updated in the last 5 s). Mirrors open-design's
 * "latest todo snapshot wins" discipline: the source of truth is `mode.tasks`,
 * which the backend keeps current via `task_update` events.
 */

import { useState } from "react";
import type { AgentTask } from "@shared/types.ts";
import { TaskGlyph } from "../lib/taskGlyph.tsx";
import styles from "./PinnedTodoSlot.module.css";

const MAX_VISIBLE = 5;
const STALE_MS = 5_000;

export interface PinnedTodoSlotProps {
  tasks: AgentTask[];
}

export function PinnedTodoSlot({ tasks }: PinnedTodoSlotProps) {
  const [expanded, setExpanded] = useState(false);

  if (tasks.length === 0) return null;

  const hasOpen = tasks.some((t) => t.status !== "completed" && t.status !== "failed" && t.status !== "stopped");
  const freshest = tasks.reduce((m, t) => Math.max(m, t.updatedAt), 0);
  const isLive = hasOpen || Date.now() - freshest < STALE_MS;
  if (!isLive) return null;

  const done = tasks.filter((t) => t.status === "completed").length;
  const inProgress = tasks.filter((t) => t.status === "in_progress").length;
  const countLabel = `${done + inProgress} of ${tasks.length}`;

  const visible = expanded ? tasks : tasks.slice(0, MAX_VISIBLE);
  const hidden = tasks.length - visible.length;

  return (
    <div className={`${styles.slot} kz-glass`} role="status" aria-live="polite">
      <div className={styles.header}>
        <span className={styles.title}>Tasks</span>
        <span className={styles.count}>{countLabel}</span>
      </div>
      <ul className={styles.list}>
        {visible.map((task) => (
          <li key={task.id} className={styles.item} data-status={task.status}>
            <TaskGlyph status={task.status} />
            <span className={styles.subject}>{task.subject}</span>
            {task.status === "in_progress" && task.description && (
              <span className={styles.active}>{task.description}</span>
            )}
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <button
          type="button"
          className={styles.showAll}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Show less" : `Show all (${tasks.length})`}
        </button>
      )}
    </div>
  );
}
