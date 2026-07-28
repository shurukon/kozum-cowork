/**
 * Kozum Cowork — tool invocation card.
 *
 * Collapsible card for a single tool call. Shows icon, summary line, and
 * status indicator (spinner / check / error). Expandable detail renders
 * terminal output, diffs, file chips, or raw JSON depending on the tool's
 * display payload.
 */

import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CheckCircle,
  XCircle,
  Terminal,
  FileText,
  Globe,
  Cpu,
  Code2,
  FolderOpen,
  Search,
  MousePointer2,
  Camera,
  Zap,
  ListTodo,
  Puzzle,
  Database,
  Wrench,
  Layers,
} from "lucide-react";
import type { ToolDisplay } from "@shared/types.ts";
import type { ToolCard as ToolCardType } from "../store/session.ts";
import styles from "./ToolCard.module.css";

// ── Icon map ────────────────────────────────────────────────────────────────

const ICON_MAP: Record<string, typeof Terminal> = {
  terminal: Terminal,
  shell: Terminal,
  bash: Terminal,
  file: FileText,
  read_file: FileText,
  write_file: FileText,
  glob: Search,
  grep: Search,
  search: Search,
  web: Globe,
  fetch: Globe,
  browse: Globe,
  browser: Globe,
  computer: Cpu,
  screenshot: Camera,
  mouse: MousePointer2,
  code: Code2,
  folder: FolderOpen,
  dir: FolderOpen,
  task: ListTodo,
  jobs: ListTodo,
  mcp: Puzzle,
  plugin: Puzzle,
  memory: Database,
  system: Layers,
  ask: Zap,
};

function getIcon(toolName: string): typeof Terminal {
  const lower = toolName.toLowerCase();
  for (const [key, Icon] of Object.entries(ICON_MAP)) {
    if (lower.includes(key)) return Icon;
  }
  return Wrench;
}

// ── Diff renderer ──────────────────────────────────────────────────────────

function DiffView({ diff }: { diff: NonNullable<ToolDisplay["diff"]> }) {
  const beforeLines = diff.before.split("\n");
  const afterLines = diff.after.split("\n");

  // Simple line-based diff: removed (red) = lines only in before, added (green)
  // = lines only in after. For display purposes we align them.
  const maxLen = Math.max(beforeLines.length, afterLines.length);
  const rows: Array<{ kind: "context" | "removed" | "added"; text: string }> = [];

  for (let i = 0; i < maxLen; i++) {
    const b = i < beforeLines.length ? beforeLines[i] : undefined;
    const a = i < afterLines.length ? afterLines[i] : undefined;
    if (b === a) {
      rows.push({ kind: "context", text: b ?? "" });
    } else {
      if (b !== undefined) rows.push({ kind: "removed", text: b });
      if (a !== undefined) rows.push({ kind: "added", text: a });
    }
  }

  return (
    <div className={styles.diff}>
      <div className={styles.diffPath}>{diff.path}</div>
      <pre className={styles.diffPre}>
        {rows.map((r, i) => (
          <div
            key={i}
            className={
              r.kind === "removed"
                ? styles.diffRemoved
                : r.kind === "added"
                  ? styles.diffAdded
                  : styles.diffContext
            }
          >
            <span className={styles.diffGutter}>
              {r.kind === "removed" ? "-" : r.kind === "added" ? "+" : " "}
            </span>
            {r.text}
          </div>
        ))}
      </pre>
    </div>
  );
}

// ── Terminal renderer ──────────────────────────────────────────────────────

function TerminalView({ terminal }: { terminal: NonNullable<ToolDisplay["terminal"]> }) {
  const hasOutput = terminal.stdout.length > 0 || terminal.stderr.length > 0;
  return (
    <div className={styles.terminal}>
      <div className={styles.terminalCommand}>
        <span className={styles.terminalPrompt}>$</span>
        {terminal.command}
      </div>
      {hasOutput && (
        <pre className={styles.terminalOutput}>
          {terminal.stdout && <span>{terminal.stdout}</span>}
          {terminal.stderr && (
            <span className={styles.terminalStderr}>{terminal.stderr}</span>
          )}
        </pre>
      )}
      {terminal.exitCode !== null && terminal.exitCode !== 0 && (
        <div className={styles.terminalExit}>Exit {terminal.exitCode}</div>
      )}
    </div>
  );
}

// ── File chips ─────────────────────────────────────────────────────────────

function FileChips({ files }: { files: string[] }) {
  return (
    <div className={styles.chips}>
      {files.map((f) => (
        <button key={f} className={styles.chip} title={f}>
          <FileText size={12} />
          <span className="kz-truncate">{f.split("/").pop() ?? f}</span>
        </button>
      ))}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

interface Props {
  card: ToolCardType;
}

export function ToolCard({ card }: Props) {
  const [expanded, setExpanded] = useState(false);
  const Icon = getIcon(card.name);
  const display = card.result?.display;

  const hasDetail = Boolean(
    display?.detail ||
      display?.diff ||
      display?.files?.length ||
      display?.terminal ||
      card.result?.error,
  );

  return (
    <div
      className={`${styles.card} ${card.status === "error" ? styles.cardError : card.status === "ok" ? styles.cardOk : styles.cardRunning}`}
    >
      <button
        className={styles.header}
        onClick={() => hasDetail && setExpanded((v) => !v)}
        disabled={!hasDetail}
        aria-expanded={expanded}
      >
        <span className={styles.iconWrap}>
          <Icon size={14} />
        </span>

        <span className={styles.summary}>
          {display?.summary ?? card.name}
        </span>

        {card.notes.length > 0 && (
          <span className={styles.note}>{card.notes[card.notes.length - 1]}</span>
        )}

        <span className={styles.status}>
          {card.status === "running" && (
            <span
              className={`${styles.spinner} kz-spin`}
              aria-label="Running"
            />
          )}
          {card.status === "ok" && (
            <CheckCircle size={14} className={styles.ok} aria-label="Done" />
          )}
          {card.status === "error" && (
            <XCircle size={14} className={styles.error} aria-label="Error" />
          )}
        </span>

        {hasDetail && (
          <span className={styles.chevron}>
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </span>
        )}
      </button>

      {expanded && hasDetail && (
        <div className={styles.detail}>
          {display?.terminal && <TerminalView terminal={display.terminal} />}
          {display?.diff && <DiffView diff={display.diff} />}
          {display?.files && display.files.length > 0 && (
            <FileChips files={display.files} />
          )}
          {display?.detail && !display.terminal && !display.diff && (
            <pre className={styles.rawDetail}>{display.detail}</pre>
          )}
          {card.result?.error && (
            <p className={styles.errorMsg}>{card.result.error}</p>
          )}
        </div>
      )}
    </div>
  );
}
