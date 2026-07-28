/**
 * Kozum Cowork — right panel.
 *
 * Shows Progress (task list), Working folder, and Context (connectors).
 * Each section is independently collapsible.
 */

import { useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Plug,
  ListTodo,
  CheckCircle2,
  XCircle,
  Clock,
  Loader,
  MinusCircle,
} from "lucide-react";
import type { AgentTask, McpServerConfig } from "@shared/types.ts";
import styles from "./RightPanel.module.css";

// ── Task status glyphs ─────────────────────────────────────────────────────

function TaskGlyph({ status }: { status: AgentTask["status"] }) {
  switch (status) {
    case "completed":
      return <CheckCircle2 size={14} className={styles.taskDone} />;
    case "failed":
      return <XCircle size={14} className={styles.taskFailed} />;
    case "in_progress":
      return (
        <span
          className={`${styles.taskSpinner} kz-spin`}
          aria-label="In progress"
        />
      );
    case "stopped":
      return <MinusCircle size={14} className={styles.taskStopped} />;
    default:
      return <Clock size={14} className={styles.taskPending} />;
  }
}

// ── Collapsible section ────────────────────────────────────────────────────

interface SectionProps {
  title: string;
  icon: typeof ListTodo;
  defaultOpen?: boolean;
  children: ReactNode;
}

function Section({ title, icon: Icon, defaultOpen = true, children }: SectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={styles.section}>
      <button
        className={styles.sectionHeader}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Icon size={13} className={styles.sectionIcon} />
        <span className={styles.sectionTitle}>{title}</span>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {open && <div className={styles.sectionBody}>{children}</div>}
    </div>
  );
}

// ── Props ──────────────────────────────────────────────────────────────────

interface Props {
  tasks: AgentTask[];
  workingFolder: string | null;
  connectors: McpServerConfig[];
}

export function RightPanel({ tasks, workingFolder, connectors }: Props) {
  return (
    <aside className={styles.panel} aria-label="Side panel">
      {/* Progress */}
      <Section title="Progress" icon={ListTodo}>
        {tasks.length === 0 ? (
          <p className={styles.empty}>No tasks yet.</p>
        ) : (
          <ul className={styles.taskList}>
            {tasks.map((t) => (
              <li key={t.id} className={styles.task}>
                <TaskGlyph status={t.status} />
                <div className={styles.taskInfo}>
                  <span className={styles.taskSubject}>{t.subject}</span>
                  {t.description && (
                    <span className={styles.taskDesc}>{t.description}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Working folder */}
      <Section title="Working folder" icon={FolderOpen} defaultOpen={Boolean(workingFolder)}>
        {workingFolder ? (
          <button className={styles.folderPath} title={workingFolder}>
            <FolderOpen size={13} />
            <span className="kz-truncate">{workingFolder}</span>
          </button>
        ) : (
          <p className={styles.empty}>No folder selected.</p>
        )}
      </Section>

      {/* Context / connectors */}
      <Section title="Context" icon={Plug} defaultOpen={connectors.length > 0}>
        {connectors.length === 0 ? (
          <p className={styles.empty}>No connectors active.</p>
        ) : (
          <ul className={styles.connectorList}>
            {connectors.map((c) => (
              <li key={c.id} className={styles.connector}>
                <span
                  className={`${styles.connStatus} ${
                    c.status === "connected"
                      ? styles.connOk
                      : c.status === "error"
                        ? styles.connErr
                        : styles.connIdle
                  }`}
                />
                <span className={styles.connName}>{c.name}</span>
                {c.status === "connecting" && (
                  <Loader size={11} className={`${styles.connLoader} kz-spin`} />
                )}
                <span className={styles.connTools}>{c.toolCount} tools</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </aside>
  );
}
