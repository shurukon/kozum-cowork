/**
 * Kozum Cowork — tool invocation card (redesigned).
 *
 * Collapsible glass card for a single tool call. Every card:
 * - Is wrapped in .kz-glass for the translucent pane look.
 * - Gains .kz-glass-sweep on mount (entrance sheen).
 * - Gains .kz-glass-busy while the tool is running (repeating sweep).
 * - Drops .kz-glass-busy on completion/error.
 *
 * Header: tool icon from toolIcons.ts + human label + status indicator.
 * Collapsed: shows display.summary. Click to expand.
 * Expanded: terminal block (with copy button), diff view, file chips, detail.
 *
 * Error state: CSS flash animation once, then a muted accent border.
 * onOpenFile: called when the user clicks a file chip.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import {
  ChevronDown,
  ChevronRight,
  CheckCircle,
  XCircle,
  Copy,
  Check,
  FileText,
} from "lucide-react";
import * as LucideIcons from "lucide-react";
import type { ToolDisplay } from "@shared/types.ts";
import type { ToolCard as ToolCardType } from "../store/session.ts";
import { toolIcon } from "../lib/toolIcons.ts";
import styles from "./ToolCard.module.css";

// ── Dynamic icon lookup ─────────────────────────────────────────────────────

type LucideComponent = React.ComponentType<{ size?: number; className?: string }>;

/**
 * Map a kebab-case lucide icon name (e.g. "file-plus") to the React component.
 * Lucide exports PascalCase names, e.g. FilePlus.
 */
function getLucideIcon(name: string): LucideComponent {
  // "file-plus" → "FilePlus"
  const pascal = name
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");

  const icons = LucideIcons as unknown as Record<string, LucideComponent | undefined>;
  return icons[pascal] ?? (LucideIcons.Wrench as LucideComponent);
}

// ── Diff renderer ──────────────────────────────────────────────────────────

function DiffView({ diff }: { diff: NonNullable<ToolDisplay["diff"]> }) {
  const beforeLines = diff.before.split("\n");
  const afterLines = diff.after.split("\n");

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

// ── Terminal renderer (with copy button) ────────────────────────────────────

function TerminalView({ terminal }: { terminal: NonNullable<ToolDisplay["terminal"]> }) {
  const [copied, setCopied] = useState(false);

  const fullOutput = [terminal.stdout, terminal.stderr].filter(Boolean).join("\n");

  const copy = useCallback(async () => {
    await navigator.clipboard.writeText(fullOutput).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [fullOutput]);

  const hasOutput = terminal.stdout.length > 0 || terminal.stderr.length > 0;
  return (
    <div className={styles.terminal}>
      <div className={styles.terminalHeader}>
        <div className={styles.terminalCommand}>
          <span className={styles.terminalPrompt}>$</span>
          {terminal.command}
        </div>
        {hasOutput && (
          <button
            className={styles.copyBtn}
            onClick={copy}
            aria-label="Copy terminal output"
            title="Copy output"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
        )}
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

interface FileChipsProps {
  files: string[];
  onOpenFile?: (path: string) => void;
}

function FileChips({ files, onOpenFile }: FileChipsProps) {
  return (
    <div className={styles.chips}>
      {files.map((f) => (
        <button
          key={f}
          className={styles.chip}
          title={f}
          onClick={() => onOpenFile?.(f)}
        >
          <FileText size={12} />
          <span className="kz-truncate">{f.split("/").pop() ?? f}</span>
        </button>
      ))}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export interface ToolCardProps {
  card: ToolCardType;
  /** Called when the user clicks a file chip in the expanded detail. */
  onOpenFile?: (path: string) => void;
}

export function ToolCard({ card, onOpenFile }: ToolCardProps) {
  const [expanded, setExpanded] = useState(false);
  // Sweep fires once on mount; swept tracks whether we've applied it.
  const [swept, setSwept] = useState(false);
  const sweepTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Apply kz-glass-sweep on mount, remove after animation completes.
  useEffect(() => {
    setSwept(true);
    sweepTimerRef.current = setTimeout(() => setSwept(false), 1200);
    return () => {
      if (sweepTimerRef.current) clearTimeout(sweepTimerRef.current);
    };
  }, []);

  const { icon: iconName, label: humanLabel } = toolIcon(card.name);
  const Icon = getLucideIcon(iconName);
  const display = card.result?.display;

  const hasDetail = Boolean(
    display?.detail ||
      display?.diff ||
      display?.files?.length ||
      display?.terminal ||
      card.result?.error,
  );

  // Build the className set for the card.
  const isRunning = card.status === "running";
  const isError = card.status === "error";
  const isOk = card.status === "ok";

  const cardClass = [
    styles.card,
    "kz-glass",
    swept ? "kz-glass-sweep" : "",
    isRunning ? "kz-glass-busy" : "",
    isError ? styles.cardError : isOk ? styles.cardOk : styles.cardRunning,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cardClass}>
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
          {display?.summary ?? humanLabel}
        </span>

        {card.notes.length > 0 && (
          <span className={styles.note}>{card.notes[card.notes.length - 1]}</span>
        )}

        <span className={styles.status}>
          {isRunning && (
            <span
              className={`${styles.spinner} kz-spin`}
              aria-label="Running"
            />
          )}
          {isOk && (
            <CheckCircle size={14} className={styles.ok} aria-label="Done" />
          )}
          {isError && (
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
            <FileChips files={display.files} onOpenFile={onOpenFile} />
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
