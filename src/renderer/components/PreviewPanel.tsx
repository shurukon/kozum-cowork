/**
 * Kozum Cowork — PreviewPanel.
 *
 * Shared built-in preview for both Cowork and Code modes. Controlled: App
 * decides what to preview and passes a PreviewTarget; this component renders it.
 *
 * Supported target kinds:
 *   • file       — text (syntax-neutral mono + line numbers), markdown, image, pdf, binary
 *   • url        — sandboxed iframe when safe, informational placeholder otherwise
 *   • project    — devUrl iframe when running, folder summary otherwise
 *   • computer   — base64 computer-use screenshot
 *   • mcp        — pretty-printed MCP result JSON
 *
 * IPC: uses bridge().preview.readFile / bridge().preview.stat added by
 * src/main/ipc/index.ts. Falls back gracefully when the handlers are absent.
 */

import { useEffect, useState, useCallback } from "react";
import { X, RefreshCw, FileText, Globe, Monitor, Plug, FolderOpen, AlertCircle, Download } from "lucide-react";
import { bridge } from "../bridge.ts";
import type { Result } from "@shared/types.ts";
import { Markdown } from "./Markdown.tsx";
import { previewKindForPath } from "../lib/previewKind.ts";
import styles from "./PreviewPanel.module.css";

// ── PreviewTarget discriminated union ────────────────────────────────────

export type PreviewTarget =
  | { kind: "file"; path: string }
  | { kind: "url"; url: string }
  | { kind: "project"; path: string; devUrl?: string }
  | { kind: "computer"; imageData: string }
  | { kind: "mcp"; server: string; payload: unknown };

// ── Preview bridge types ───────────────────────────────────────────────

interface ReadFileResult {
  content: string;
  base64?: string;
  mime: string;
  truncated: boolean;
}

interface StatResult {
  size: number;
  isDir: boolean;
}

/**
 * Safely call bridge.preview.readFile if available, otherwise error.
 */
async function safeReadFile(path: string): Promise<Result<ReadFileResult>> {
  try {
    const b = bridge() as unknown as {
      preview?: { readFile: (p: string) => Promise<Result<ReadFileResult>> };
    };
    if (typeof b.preview?.readFile !== "function") {
      return { ok: false, error: "preview:readFile not available in this build." };
    }
    return b.preview.readFile(path);
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function safeStat(path: string): Promise<Result<StatResult>> {
  try {
    const b = bridge() as unknown as {
      preview?: { stat: (p: string) => Promise<Result<StatResult>> };
    };
    if (typeof b.preview?.stat !== "function") {
      return { ok: false, error: "preview:stat not available in this build." };
    }
    return b.preview.stat(path);
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ── Kind icon ─────────────────────────────────────────────────────────────

function kindIcon(target: PreviewTarget) {
  switch (target.kind) {
    case "file": return FileText;
    case "url": return Globe;
    case "project": return FolderOpen;
    case "computer": return Monitor;
    case "mcp": return Plug;
  }
}

function targetTitle(target: PreviewTarget): string {
  switch (target.kind) {
    case "file": {
      const base = target.path.split("/").pop() ?? target.path.split("\\").pop() ?? target.path;
      return base;
    }
    case "url": return target.url;
    case "project": {
      const base = target.path.split("/").pop() ?? target.path.split("\\").pop() ?? target.path;
      return base || target.path;
    }
    case "computer": return "Computer screenshot";
    case "mcp": return target.server;
  }
}

// ── Loading shimmer ────────────────────────────────────────────────────────

function LoadingShimmer() {
  return (
    <div className={styles.shimmerWrap} aria-busy="true" aria-label="Loading preview">
      <div className={`${styles.shimmerLine} ${styles.shimmerLong}`} />
      <div className={`${styles.shimmerLine} ${styles.shimmerMed}`} />
      <div className={`${styles.shimmerLine} ${styles.shimmerShort}`} />
      <div className={`${styles.shimmerLine} ${styles.shimmerLong}`} />
      <div className={`${styles.shimmerLine} ${styles.shimmerMed}`} />
    </div>
  );
}

// ── Inline error ───────────────────────────────────────────────────────────

function PreviewError({ message }: { message: string }) {
  return (
    <div className={styles.errorWrap} role="alert">
      <AlertCircle size={16} className={styles.errorIcon} aria-hidden="true" />
      <p className={styles.errorMsg}>{message}</p>
    </div>
  );
}

// ── File preview ───────────────────────────────────────────────────────────

function FilePreview({ path }: { path: string }) {
  const kind = previewKindForPath(path);
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ok"; data: ReadFileResult }
    | { status: "err"; message: string }
  >({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

    if (kind === "binary") {
      // For binary files, only stat for size
      safeStat(path).then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setState({
            status: "ok",
            data: {
              content: "",
              mime: "application/octet-stream",
              truncated: false,
              base64: undefined,
            },
          });
        } else {
          setState({ status: "err", message: res.error });
        }
      });
      return () => { cancelled = true; };
    }

    safeReadFile(path).then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setState({ status: "ok", data: res.value });
      } else {
        setState({ status: "err", message: res.error });
      }
    });

    return () => { cancelled = true; };
  }, [path, kind]);

  if (state.status === "loading") return <LoadingShimmer />;
  if (state.status === "err") return <PreviewError message={state.message} />;

  const data = state.data;

  // Image
  if (kind === "image") {
    if (data.base64 && data.mime) {
      return (
        <div className={styles.imageWrap}>
          <img
            src={`data:${data.mime};base64,${data.base64}`}
            alt={path}
            className={styles.previewImage}
          />
        </div>
      );
    }
    return <PreviewError message="Image could not be loaded." />;
  }

  // PDF
  if (kind === "pdf") {
    return (
      <div className={styles.pdfWrap}>
        <FileText size={32} className={styles.pdfIcon} aria-hidden="true" />
        <p className={styles.pdfName}>{path.split("/").pop() ?? path}</p>
        <p className={styles.pdfHint}>PDF preview is not available inline.</p>
        <button
          className={styles.openExternalBtn}
          onClick={() => {
            // Shell.openExternal would live here in a real wiring — emit a no-op
            // note for now; the event can be lifted to App.
          }}
          type="button"
        >
          <Download size={13} aria-hidden="true" />
          Open externally
        </button>
      </div>
    );
  }

  // Binary
  if (kind === "binary") {
    const ext = path.split(".").pop() ?? "";
    return (
      <div className={styles.binaryWrap}>
        <FileText size={28} className={styles.binaryIcon} aria-hidden="true" />
        <p className={styles.binaryType}>.{ext} file</p>
        <p className={styles.binaryHint}>Binary file — no inline preview available.</p>
        <button
          className={styles.openExternalBtn}
          onClick={() => {
            // Open externally — handled by App via onOpenPath
          }}
          type="button"
        >
          <Download size={13} aria-hidden="true" />
          Open externally
        </button>
      </div>
    );
  }

  // Markdown
  if (kind === "markdown") {
    return (
      <div className={styles.markdownWrap}>
        {data.truncated && (
          <p className={styles.truncNote}>File truncated — showing first ~512 KB.</p>
        )}
        <Markdown content={data.content} className={styles.markdownBody} />
      </div>
    );
  }

  // Text (default)
  const lines = data.content.split("\n");
  return (
    <div className={styles.textWrap}>
      {data.truncated && (
        <p className={styles.truncNote}>File truncated — showing first ~512 KB.</p>
      )}
      <pre className={styles.textPre} aria-label="File contents">
        <table className={styles.lineTable}>
          <tbody>
            {lines.map((line, i) => (
              <tr key={i} className={styles.lineRow}>
                <td className={styles.lineNum} aria-hidden="true">
                  {i + 1}
                </td>
                <td className={styles.lineContent}>{line}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </pre>
    </div>
  );
}

// ── URL preview ───────────────────────────────────────────────────────────

function UrlPreview({ url }: { url: string }) {
  // Only attempt iframe for http/https.
  const safe = /^https?:\/\//i.test(url);

  if (!safe) {
    return (
      <div className={styles.urlFallback}>
        <Globe size={24} className={styles.urlIcon} aria-hidden="true" />
        <p className={styles.urlText}>{url}</p>
        <p className={styles.urlNote}>
          URL scheme is not supported for inline preview.
        </p>
      </div>
    );
  }

  return (
    <div className={styles.iframeWrap}>
      {/*
       * Sandboxed iframe: allow-scripts is intentionally omitted so scripts from
       * arbitrary sites cannot run in this context. Many sites block cross-origin
       * framing via X-Frame-Options / CSP — they will show a blank frame, which
       * is expected and honest. The real internal browser lives in main.
       */}
      <p className={styles.iframeNote}>
        Live browsing renders in the main window. This is a sandboxed static
        preview — some sites may not load.
      </p>
      <iframe
        src={url}
        className={styles.iframe}
        sandbox="allow-same-origin allow-forms"
        title={`Preview of ${url}`}
        referrerPolicy="no-referrer"
      />
    </div>
  );
}

// ── Project preview ───────────────────────────────────────────────────────

function ProjectPreview({ path, devUrl }: { path: string; devUrl?: string }) {
  if (devUrl) {
    return (
      <div className={styles.iframeWrap}>
        <p className={styles.iframeNote}>Dev server running at {devUrl}</p>
        <iframe
          src={devUrl}
          className={styles.iframe}
          sandbox="allow-scripts allow-same-origin allow-forms"
          title={`Dev server: ${devUrl}`}
          referrerPolicy="no-referrer"
        />
      </div>
    );
  }
  // No dev server: show folder summary
  return (
    <div className={styles.projectWrap}>
      <FolderOpen size={28} className={styles.projectIcon} aria-hidden="true" />
      <p className={styles.projectPath}>{path}</p>
      <p className={styles.projectHint}>
        Start a dev server to preview this project here.
      </p>
    </div>
  );
}

// ── Computer screenshot preview ───────────────────────────────────────────

function ComputerPreview({ imageData }: { imageData: string }) {
  // imageData is base64; assume JPEG (computer use screenshots are JPEG)
  const src = imageData.startsWith("data:")
    ? imageData
    : `data:image/jpeg;base64,${imageData}`;
  return (
    <div className={styles.imageWrap}>
      <img
        src={src}
        alt="Computer screenshot"
        className={styles.previewImage}
      />
    </div>
  );
}

// ── MCP result preview ────────────────────────────────────────────────────

function McpPreview({ server, payload }: { server: string; payload: unknown }) {
  const pretty = JSON.stringify(payload, null, 2);
  return (
    <div className={styles.mcpWrap}>
      <p className={styles.mcpServer}>{server}</p>
      <pre className={styles.mcpPre}>{pretty}</pre>
    </div>
  );
}

// ── Props ──────────────────────────────────────────────────────────────────

export interface PreviewPanelProps {
  target: PreviewTarget | null;
  onClose: () => void;
  onRefresh?: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────

export function PreviewPanel({ target, onClose, onRefresh }: PreviewPanelProps) {
  const [refreshKey, setRefreshKey] = useState(0);

  const handleRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
    onRefresh?.();
  }, [onRefresh]);

  if (!target) return null;

  const Icon = kindIcon(target);
  const title = targetTitle(target);

  return (
    <aside className={`${styles.panel} kz-glass`} aria-label="Preview">
      {/* Header */}
      <header className={styles.header}>
        <Icon size={14} className={styles.headerIcon} aria-hidden="true" />
        <span className={styles.headerTitle} title={title}>
          {title}
        </span>
        <div className={styles.headerActions}>
          <button
            className={styles.iconBtn}
            onClick={handleRefresh}
            aria-label="Refresh preview"
            title="Refresh"
            type="button"
          >
            <RefreshCw size={13} aria-hidden="true" />
          </button>
          <button
            className={styles.iconBtn}
            onClick={onClose}
            aria-label="Close preview"
            title="Close"
            type="button"
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      </header>

      {/* Body */}
      <div className={styles.body} key={`${target.kind}-${refreshKey}`}>
        {target.kind === "file" && <FilePreview path={target.path} />}
        {target.kind === "url" && <UrlPreview url={target.url} />}
        {target.kind === "project" && (
          <ProjectPreview path={target.path} devUrl={target.devUrl} />
        )}
        {target.kind === "computer" && (
          <ComputerPreview imageData={target.imageData} />
        )}
        {target.kind === "mcp" && (
          <McpPreview server={target.server} payload={target.payload} />
        )}
      </div>
    </aside>
  );
}
