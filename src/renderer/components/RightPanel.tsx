/**
 * Kozum Cowork — RightPanel (Cowork mode).
 *
 * Three collapsible, glass-trimmed sections:
 *   1. Progress   — live task list via TaskList
 *   2. Context    — MCP / tools / plugins / folder / files via ContextPanel
 *
 * Sections default open when they have content; the user can collapse them.
 */

import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, ListTodo, Plug } from "lucide-react";
import type { AgentTask, McpServerConfig } from "@shared/types.ts";
import { TaskList } from "./TaskList.tsx";
import { ContextPanel } from "./ContextPanel.tsx";
import styles from "./RightPanel.module.css";

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
    <div className={`${styles.section} kz-glass`}>
      <button
        className={styles.sectionHeader}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        type="button"
      >
        <Icon size={12} className={styles.sectionIcon} aria-hidden="true" />
        <span className={styles.sectionTitle}>{title}</span>
        {open ? (
          <ChevronDown size={12} aria-hidden="true" />
        ) : (
          <ChevronRight size={12} aria-hidden="true" />
        )}
      </button>
      {open && <div className={styles.sectionBody}>{children}</div>}
    </div>
  );
}

// ── Props ──────────────────────────────────────────────────────────────────

export interface RightPanelProps {
  tasks: AgentTask[];
  mcpServers: McpServerConfig[];
  plugins: { name: string }[];
  toolsUsed: string[];
  workingFolder: string | null;
  sharedFiles: string[];
  onOpenPath: (path: string) => void;
}

// ── Component ──────────────────────────────────────────────────────────────

export function RightPanel({
  tasks,
  mcpServers,
  plugins,
  toolsUsed,
  workingFolder,
  sharedFiles,
  onOpenPath,
}: RightPanelProps) {
  const hasContext =
    mcpServers.length > 0 ||
    toolsUsed.length > 0 ||
    plugins.length > 0 ||
    workingFolder !== null ||
    sharedFiles.length > 0;

  return (
    <aside className={styles.panel} aria-label="Side panel">
      {/* Progress section */}
      <Section
        title="Progress"
        icon={ListTodo}
        defaultOpen={tasks.length > 0}
      >
        <TaskList tasks={tasks} />
      </Section>

      {/* Context section */}
      <Section
        title="Context"
        icon={Plug}
        defaultOpen={hasContext}
      >
        <ContextPanel
          mcpServers={mcpServers}
          plugins={plugins}
          toolsUsed={toolsUsed}
          workingFolder={workingFolder}
          sharedFiles={sharedFiles}
          onOpenPath={onOpenPath}
        />
      </Section>
    </aside>
  );
}
