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
import { TaskGlyph } from "../lib/taskGlyph.tsx";

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
