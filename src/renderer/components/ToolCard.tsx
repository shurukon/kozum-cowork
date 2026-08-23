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
import { useTranslation } from "react-i18next";
import type { PreviewTarget } from "./PreviewPanel.tsx";
import {
  ChevronDown,
  ChevronRight,
  CheckCircle,
  XCircle,
  Copy,
  Check,
  FileText,
} from "lucide-react";
import type { ToolDisplay } from "@shared/types.ts";
import type { ToolCard as ToolCardType } from "../store/session.ts";
import { toolIcon } from "../lib/toolIcons.ts";
import { toolCategory } from "../lib/toolCategory.ts";
import styles from "./ToolCard.module.css";
import { ToolGlyph } from "./ToolGlyph.tsx";

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

// ── Tool input viewer (F-4) ─────────────────────────────────────────────────

/**
 * F-4: a compact viewer for the tool's input payload. Hides empty/null/undefined
 * values, special-cases "command" (terminal-styled) and renders everything else
 * as either a flat key/value list or a JSON fallback.
 */
function hasInput(input: unknown): boolean {
  if (input === null || input === undefined) return false;
  if (typeof input !== "object") return false;
  const rec = input as Record<string, unknown>;
  const keys = Object.keys(rec);
  if (keys.length === 0) return false;
  return keys.some((k) => {
    const v = rec[k];
    if (v === null || v === undefined) return false;
    if (typeof v === "string") return v.length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") return Object.keys(v as Record<string, unknown>).length > 0;
    return true;
  });
}

function formatInput(input: unknown, _toolName: string): {
  command?: string;
  kv: Array<{ key: string; value: string }>;
  json?: string;
} {
  if (input === null || input === undefined || typeof input !== "object") {
    return { kv: [] };
  }
  const rec = input as Record<string, unknown>;
  const entries = Object.entries(rec).filter(([, v]) => {
    if (v === null || v === undefined) return false;
    if (typeof v === "string") return v.length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") return Object.keys(v as Record<string, unknown>).length > 0;
    return true;
  });

  const commandEntry = entries.find(([k]) => k === "command" || k === "cmd");
  const command =
    commandEntry && typeof commandEntry[1] === "string" ? commandEntry[1] : undefined;

  const kv: Array<{ key: string; value: string }> = [];
  let json: string | undefined;
  for (const [k, v] of entries) {
    if (k === commandEntry?.[0]) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      kv.push({ key: k, value: String(v) });
    } else {
      try {
        kv.push({ key: k, value: JSON.stringify(v) });
      } catch {
        kv.push({ key: k, value: String(v) });
      }
    }
  }

  // If a single non-string field dominates, fall back to pretty JSON.
  const nonScalarCount = entries.filter(([, v]) => typeof v === "object").length;
  if (nonScalarCount >= 2) {
    try {
      json = JSON.stringify(input, null, 2);
    } catch {
      /* keep empty */
    }
  }

  return { command, kv, json };
}

interface ToolInputViewProps {
  input: unknown;
  toolName: string;
}

function ToolInputView({ input, toolName }: ToolInputViewProps): React.ReactNode {
  const { t } = useTranslation();
  if (!hasInput(input)) return null;
  const { command, kv, json } = formatInput(input, toolName);
  return (
    <div className={styles.inputView} aria-label="Tool input">
      <div className={styles.inputHeader}>
        <span className={styles.inputLabel}>{t("toolCard.input")}</span>
        <span className={styles.inputToolName}>{toolName}</span>
      </div>
      {command && (
        <pre className={styles.inputCmd}>
          <span className={styles.terminalPrompt} aria-hidden={true}>$</span>
          {command}
        </pre>
      )}
      {kv.length > 0 && (
        <dl className={styles.inputKv}>
          {kv.map(({ key, value }) => (
            <div key={key} className={styles.inputKvRow}>
              <dt className={styles.inputKvKey}>{key}</dt>
              <dd className={styles.inputKvVal}>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {json && <pre className={styles.inputJson}>{json}</pre>}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export interface ToolCardProps {
  card: ToolCardType;
  /** Called when the user clicks a file chip in the expanded detail. */
  onOpenFile?: (path: string) => void;
  /** Open the preview panel (used by thumbnail clicks). */
  onPreview?: (target: PreviewTarget) => void;
  /** Render as an inline activity row inside the assistant timeline. */
  inline?: boolean;
}

const MAX_THUMBNAILS = 12;

export function ToolCard({ card, onOpenFile, onPreview, inline = false }: ToolCardProps) {
  const { t } = useTranslation();
  // Cowork activity rows stay compact while live so the timeline remains
  // readable. Code mode keeps the existing expanded-running/error behavior;
  // users can still open every inline detail explicitly.
  const initialExpanded = inline ? false : card.status === "running" || card.status === "error";
  const [expanded, setExpanded] = useState(initialExpanded);
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

  const { label: humanLabel } = toolIcon(card.name);
  const display = card.result?.display;
  const category = toolCategory(card.name);

  const hasDetail = Boolean(
    display?.detail ||
      display?.diff ||
      display?.files?.length ||
      display?.terminal ||
      card.result?.images?.length ||
      card.result?.error ||
      hasInput(card.input),
  );

  // Build the className set for the card.
  const isRunning = card.status === "running";
  const isError = card.status === "error";
  const isOk = card.status === "ok";

  const cardClass = [
    styles.card,
    inline ? styles.inline : "",
    "kz-glass",
    swept ? "kz-glass-sweep" : "",
    isRunning ? "kz-glass-busy" : "",
    isError ? styles.cardError : isOk ? styles.cardOk : styles.cardRunning,
  ]
    .filter(Boolean)
    .join(" ");

  const summaryClass = isRunning
    ? `${styles.summary} shimmer-text`
    : styles.summary;

  return (
    <div
      className={cardClass}
      data-tool-category={category}
      data-tool-state={card.status}
    >
      <button
        className={styles.header}
        onClick={() => hasDetail && setExpanded((v) => !v)}
        disabled={!hasDetail}
        aria-expanded={expanded}
      >
          <span className={styles.iconWrap}>
            <ToolGlyph toolName={card.name} size={16} />
          </span>

        <span className={summaryClass}>
          {display?.summary ?? humanLabel}
      </span>

        {card.notes.length > 0 && (
          <span className={styles.note}>{card.notes[card.notes.length - 1]}</span>
        )}

        <span className={styles.status}>
          {isRunning && (
            <span
              className={`${styles.spinner} kz-spin`}
              aria-label={t("toolCard.running")}
            />
          )}
          {isOk && (
            <CheckCircle size={14} className={styles.ok} aria-label={t("toolCard.done")} />
          )}
          {isError && (
            <XCircle size={14} className={styles.error} aria-label={t("toolCard.error")} />
          )}
        </span>

{hasDetail && (
          <span className={styles.chevron}>
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </span>
        )}
      </button>

      {/* Pending permission prompts render in the AskDock above the composer,
          never inline here — the card simply shows its running state while
          awaiting approval. */}

      {expanded && hasDetail && (
        <div className={styles.detail}>
          <ToolInputView input={card.input} toolName={card.name} />
          {display?.terminal && <TerminalView terminal={display.terminal} />}
          {display?.diff && <DiffView diff={display.diff} />}
          {display?.files && display.files.length > 0 && (
            <FileChips files={display.files} onOpenFile={onOpenFile} />
          )}
          {/* Inline progress log: last 5 notes (P1-4). */}
          {card.notes.length > 0 && (
            <ul className={styles.progressLog}>
              {card.notes.slice(-5).map((n, i) => (
                <li key={i} className={styles.progressLogItem}>{n}</li>
              ))}
            </ul>
          )}
          {/* Inline thumbnails for tools that returned image tiles (§4.2). */}
          {card.result?.images && card.result.images.length > 0 && (
            <div className={styles.thumbGrid}>
              {card.result.images.slice(0, MAX_THUMBNAILS).map((im, i) => {
                // Clamp the count once full state is needed by tests; reuse the
                // computer preview target so a click opens the full image.
                const target: PreviewTarget = {
                  kind: "computer",
                  imageData: `data:${im.mimeType};base64,${im.data}`,
                };
                return (
                  <button
                    key={i}
                    type="button"
                    className={styles.thumbBtn}
                    onClick={() => onPreview?.(target)}
                    aria-label={`Open image ${i + 1} in preview`}
                  >
                    <img
                      src={`data:${im.mimeType};base64,${im.data}`}
                      alt={`Tool output image ${i + 1}`}
                      className={styles.thumbImg}
                    />
                  </button>
                );
              })}
            </div>
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
        