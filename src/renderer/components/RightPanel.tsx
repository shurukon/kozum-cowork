import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  FileText,
  Film,
  FolderOpen,
  Image as ImageIcon,
  ListTodo,
  Music,
  Package,
  Plug,
} from "lucide-react";
import type { AgentTask, McpServerConfig, Mode, SessionFileInfo } from "@shared/types.ts";
import type { SubagentView } from "../store/sessionTypes.ts";
import { TaskList } from "./TaskList.tsx";
import { SubagentCard } from "./SubagentCard.tsx";
import { UsageSummary } from "./UsageSummary.tsx";
import styles from "./RightPanel.module.css";

interface SectionProps {
  title: string;
  icon: typeof ListTodo;
  defaultOpen?: boolean;
  /** T5: incrementing tick — each change forces the section open once, then
      the user can freely collapse it again. */
  autoOpenTick?: number;
  children: ReactNode;
}

function Section({ title, icon: Icon, defaultOpen = true, autoOpenTick = 0, children }: SectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    if (autoOpenTick > 0) setOpen(true);
  }, [autoOpenTick]);

  return (
    <div className={`${styles.section} kz-glass`}>
      <button
        className={styles.sectionHeader}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        type="button"
      >
        <Icon size={12} className={styles.sectionIcon} aria-hidden="true" />
        <span className={styles.sectionTitle}>{title}</span>
        {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
      </button>
      {open && <div className={styles.sectionBody}>{children}</div>}
    </div>
  );
}

function fileIcon(kind: string) {
  switch (kind) {
    case "image": return ImageIcon;
    case "video": return Film;
    case "audio": return Music;
    case "binary": return Package;
    default: return FileText;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ── T4: session-scoped file explorer (Context section) ─────────────────── */

function SessionFilesExplorer({
  files,
  onOpenFile,
}: {
  files: SessionFileInfo[];
  onOpenFile: (path: string) => void;
}) {
  if (files.length === 0) {
    return (
      <p className={styles.emptyFiles}>No files yet in this session.</p>
    );
  }
  return (
    <div className={styles.fileExplorer} role="list" aria-label="Files created in this session">
      {files.map((file) => {
        const Icon = fileIcon(file.kind);
        return (
          <button
            key={file.path}
            type="button"
            role="listitem"
            className={styles.fileRow}
            onClick={() => onOpenFile(file.path)}
            title={`${file.path}\n${file.kind} · ${formatSize(file.size)} — click to preview`}
          >
            <Icon size={13} className={`${styles.fileIcon} ${file.kind === "image" ? styles.fileIconImage : ""}`} aria-hidden="true" />
            <span className={styles.fileName}>{file.name}</span>
            <span className={styles.fileMeta}>{formatSize(file.size)}</span>
          </button>
        );
      })}
    </div>
  );
}

export interface RightPanelProps {
  mode: Mode;
  tasks: AgentTask[];
  subagents: Record<string, SubagentView>;
  mcpServers: McpServerConfig[];
  toolsUsed: string[];
  skillsUsed: string[];
  projectName: string | null;
  workingFolder: string | null;
  /** T4: files created during the CURRENT session only (baseline-diffed upstream). */
  sessionFiles?: SessionFileInfo[];
  onOpenFile?: (path: string) => void;
}

export function RightPanel({
  mode,
  tasks,
  subagents,
  mcpServers,
  toolsUsed,
  skillsUsed,
  projectName,
  workingFolder,
  sessionFiles = [],
  onOpenFile,
}: RightPanelProps) {
  const subagentEntries = Object.values(subagents);
  const hasRunningSubagents = subagentEntries.some((subagent) => subagent.status === "running");
  const hasProgress = tasks.length > 0 || toolsUsed.length > 0 || skillsUsed.length > 0 || Boolean(projectName) || mcpServers.length > 0;

  /* T5: auto-open Progress whenever a NEW task id appears (Cowork).
     A tick counter keeps this as a one-shot nudge — the user can still
     collapse the section afterwards. */
  const [progressAutoTick, setProgressAutoTick] = useState(0);
  const seenTaskIds = useRef<Set<string>>(new Set(tasks.map((t) => t.id)));
  useEffect(() => {
    let fresh = false;
    for (const task of tasks) {
      if (!seenTaskIds.current.has(task.id)) {
        seenTaskIds.current.add(task.id);
        fresh = true;
      }
    }
    if (fresh && mode === "cowork") setProgressAutoTick((t) => t + 1);
  }, [tasks, mode]);
  // Reset the baseline when the panel remounts for a different mode.
  useEffect(() => {
    seenTaskIds.current = new Set(tasks.map((t) => t.id));
    setProgressAutoTick(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const subagentProgress = (
    <div className={styles.subagentProgress} aria-label="Subagent progress">
      <div className={styles.subagentProgressHeader}>
        <Bot size={12} aria-hidden="true" />
        <span>Subagents</span>
        {hasRunningSubagents && <span className={styles.subagentLive}>LIVE</span>}
      </div>
      {subagentEntries.length === 0 ? (
        <p className={styles.empty}>No subagent runs yet.</p>
      ) : (
        <div className={styles.subagentList}>
          {subagentEntries.map((view) => (
            <SubagentCard key={view.id} view={view} />
          ))}
        </div>
      )}
    </div>
  );

  const contextBody = (
    <>
      {/* T4: current-session artifacts first — strictly scoped upstream */}
      <SessionFilesExplorer files={sessionFiles} onOpenFile={(p) => onOpenFile?.(p)} />
      <UsageSummary
        tools={toolsUsed}
        project={projectName ? { name: projectName, folder: workingFolder } : null}
        skills={skillsUsed}
        mcpServers={mcpServers}
      />
    </>
  );

  if (mode === "cowork") {
    return (
      <aside className={`${styles.panel} ${styles.coworkPanel}`} aria-label="Cowork progress panel">
        <div className={styles.panelIntro}>
          <span className={styles.panelEyebrow}>WORKSPACE</span>
          <span className={styles.panelHint}>Live progress</span>
        </div>

        <Section
          title="Progress"
          icon={ListTodo}
          defaultOpen={tasks.length > 0 || subagentEntries.length > 0}
          autoOpenTick={progressAutoTick}
        >
          <TaskList tasks={tasks} />
          {subagentProgress}
        </Section>

        <Section title="Context" icon={Plug} defaultOpen={hasProgress}>
          {contextBody}
        </Section>
      </aside>
    );
  }

  return (
    <aside className={styles.panel} aria-label="Side panel">
      <Section title="Progress" icon={ListTodo} defaultOpen={tasks.length > 0 || subagentEntries.length > 0}>
        <TaskList tasks={tasks} />
        {subagentProgress}
      </Section>

      <Section title="Context" icon={FolderOpen} defaultOpen={hasProgress}>
        {contextBody}
      </Section>
    </aside>
  );
}
