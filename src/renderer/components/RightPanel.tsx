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
import {
  ChevronDown,
  ChevronRight,
  Cable,
  FileBox,
  FolderOpen,
  ListTodo,
  Plug,
  Bot,
} from "lucide-react";
import type { AgentTask, McpServerConfig, Mode } from "@shared/types.ts";
import type { SubagentView } from "../store/sessionTypes.ts";
import { TaskList } from "./TaskList.tsx";
import { ContextPanel } from "./ContextPanel.tsx";
import { SubagentCard } from "./SubagentCard.tsx";
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
  mode: Mode;
  tasks: AgentTask[];
  subagents: Record<string, SubagentView>;
  mcpServers: McpServerConfig[];
  plugins: { name: string }[];
  toolsUsed: string[];
  workingFolder: string | null;
  sharedFiles: string[];
  onOpenPath: (path: string) => void;
}

// ── Component ──────────────────────────────────────────────────────────────

export function RightPanel({
  mode,
  tasks,
  subagents,
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

  const subagentEntries = Object.values(subagents);
  const hasRunningSubagents = subagentEntries.some((s) => s.status === "running");
  const hasArtifacts = sharedFiles.length > 0 || workingFolder !== null;

  const contextSection = (
    <Section title="Context" icon={Plug} defaultOpen={hasContext}>
      <ContextPanel
        mcpServers={mcpServers}
        plugins={plugins}
        toolsUsed={toolsUsed}
        workingFolder={workingFolder}
        sharedFiles={sharedFiles}
        onOpenPath={onOpenPath}
      />
    </Section>
  );

  if (mode === "cowork") {
    return (
      <aside className={`${styles.panel} ${styles.coworkPanel}`} aria-label="Cowork context panel">
        <div className={styles.panelIntro}>
          <span className={styles.panelEyebrow}>WORKSPACE</span>
          <span className={styles.panelHint}>Live context</span>
        </div>

        <Section title="Progress" icon={ListTodo} defaultOpen={tasks.length > 0}>
          <TaskList tasks={tasks} />
        </Section>

        <Section title="Artifacts" icon={FileBox} defaultOpen={hasArtifacts}>
          {workingFolder ? (
            <button
              type="button"
              className={styles.artifactRow}
              onClick={() => onOpenPath(workingFolder)}
              title={workingFolder}
            >
              <FolderOpen size={14} aria-hidden="true" />
              <span className="kz-truncate">{workingFolder}</span>
            </button>
          ) : sharedFiles.length > 0 ? (
            <div className={styles.artifactList}>
              {sharedFiles.map((path) => (
                <button
                  key={path}
                  type="button"
                  className={styles.artifactRow}
                  onClick={() => onOpenPath(path)}
                  title={path}
                >
                  <FileBox size={14} aria-hidden="true" />
                  <span className="kz-truncate">{path}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className={styles.empty}>Outputs and files will appear here.</p>
          )}
        </Section>

        {contextSection}

        <Section title="Connectors" icon={Cable} defaultOpen={mcpServers.length > 0}>
          {mcpServers.length === 0 && plugins.length === 0 ? (
            <p className={styles.empty}>Connectors will appear here when enabled.</p>
          ) : (
            <div className={styles.connectorList}>
              {mcpServers.map((server) => (
                <div key={server.id} className={styles.connectorRow}>
                  <span className={styles.connectorDot} aria-hidden="true" />
                  <span className="kz-truncate">{server.name}</span>
                  <span className={styles.connectorState}>ON</span>
                </div>
              ))}
              {plugins.map((plugin) => (
                <div key={plugin.name} className={styles.connectorRow}>
                  <span className={styles.connectorDot} aria-hidden="true" />
                  <span className="kz-truncate">{plugin.name}</span>
                  <span className={styles.connectorState}>ON</span>
                </div>
              ))}
            </div>
          )}
        </Section>
      </aside>
    );
  }

  return (
    <aside className={styles.panel} aria-label="Side panel">
      <Section title="Progress" icon={ListTodo} defaultOpen={tasks.length > 0}>
        <TaskList tasks={tasks} />
      </Section>

      <Section
        title="Subagents"
        icon={Bot}
        defaultOpen={subagentEntries.length > 0 || hasRunningSubagents}
      >
        {subagentEntries.length === 0 ? (
          <p className={styles.empty}>No subagent runs yet.</p>
        ) : (
          <div className={styles.subagentList}>
            {subagentEntries.map((view) => (
              <SubagentCard key={view.id} view={view} />
            ))}
          </div>
        )}
      </Section>

      {contextSection}
    </aside>
  );
}
