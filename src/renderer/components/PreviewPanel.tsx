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
  *   • artifact    — read-only, sanitized visual artifact canvas
 *
 * HTML file targets use the hardened loopback preview server when available;
 * explicit artifact targets remain sanitized and script-free.
 *
 * IPC: uses bridge().preview.readFile / bridge().preview.stat added by
 * src/main/ipc/index.ts. Falls back gracefully when the handlers are absent.
 */

import { useEffect, useState, useCallback, useRef } from "react";
import { X, RefreshCw, FileText, Globe, Monitor, Plug, FolderOpen, AlertCircle, ShieldCheck, Copy, ExternalLink, FolderSearch, Code2, Check, GripVertical } from "lucide-react";
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
  | { kind: "mcp"; server: string; payload: unknown }
  | { kind: "browser"; sessionId?: string }
  | { kind: "artifact"; path: string; title?: string };

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

async function safeOpenLiveHtml(path: string): Promise<Result<{ url: string; path: string }>> {
  try {
    const b = bridge() as unknown as {
      preview?: {
        openLiveHtml?: (p: string) => Promise<Result<{ url: string; path: string }>>;
      };
    };
    if (typeof b.preview?.openLiveHtml !== "function") {
      return { ok: false, error: "Live HTML preview is not available in this build." };
    }
    return b.preview.openLiveHtml(path);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function safePreviewOpen(path: string, action: "external" | "reveal" | "ide"): Promise<Result<void>> {
  try {
    const b = bridge() as unknown as {
      preview?: { open?: (p: string, a?: "external" | "reveal" | "ide") => Promise<Result<void>> };
    };
    if (typeof b.preview?.open !== "function") {
      return { ok: false, error: "preview:open not available in this build." };
    }
    return b.preview.open(path, action);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
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
    case "browser": return Globe;
    case "artifact": return FileText;
  }
}

function targetTitle(target: PreviewTarget): string {
  switch (target.kind) {
    case "file": {
      const base = target.path.split("/").pop() ?? target.path.split("\\").pop() ?? target.path;
      return /\.(?:html?|xhtml)$/i.test(base) ? `Rendered design · ${base}` : base;
    }
    case "url": return target.url;
    case "project": {
      const base = target.path.split("/").pop() ?? target.path.split("\\").pop() ?? target.path;
      return base || target.path;
    }
    case "computer": return "Computer screenshot";
    case "mcp": return target.server;
    case "browser": return "Live browser";
    case "artifact": return target.title ?? (target.path.split("/").pop() ?? target.path);
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

// ── File actions ───────────────────────────────────────────────────────────

function FileActions({ path, labelled = false }: { path: string; labelled?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      setError(null);
      window.setTimeout(() => setCopied(false), 1400);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not copy path");
    }
  };

  const open = async (action: "external" | "reveal" | "ide") => {
    const result = await safePreviewOpen(path, action);
    if (!result.ok) setError(result.error);
    else setError(null);
  };

  return (
    <div className={labelled ? styles.fileActionBar : styles.compactFileActions} aria-label="File actions">
      <button className={labelled ? styles.openExternalBtn : styles.iconBtn} type="button" onClick={copyPath} title="Copy path" aria-label="Copy path">
        {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
        {labelled && (copied ? "Copied" : "Copy path")}
      </button>
      <button className={labelled ? styles.openExternalBtn : styles.iconBtn} type="button" onClick={() => void open("ide")} title="Open in IDE" aria-label="Open in IDE">
        <Code2 size={13} aria-hidden="true" />
        {labelled && "Open in IDE"}
      </button>
      <button className={labelled ? styles.openExternalBtn : styles.iconBtn} type="button" onClick={() => void open("reveal")} title="Reveal in folder" aria-label="Reveal in folder">
        <FolderSearch size={13} aria-hidden="true" />
        {labelled && "Reveal"}
      </button>
      <button className={labelled ? styles.openExternalBtn : styles.iconBtn} type="button" onClick={() => void open("external")} title="Open externally" aria-label="Open externally">
        <ExternalLink size={13} aria-hidden="true" />
        {labelled && "Open externally"}
      </button>
      {error && <span className={styles.actionError} role="alert">{error}</span>}
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

  // PDF — use Chromium's built-in PDF viewer when the file was read as base64.
  if (kind === "pdf") {
    return (
      <div className={styles.mediaWrap}>
        {data.base64 ? (
          <iframe className={styles.pdfFrame} src={`data:application/pdf;base64,${data.base64}`} title={`PDF preview: ${path}`} />
        ) : (
          <PreviewError message="PDF could not be loaded inline." />
        )}
        <FileActions path={path} labelled />
      </div>
    );
  }

  if (kind === "video" || kind === "audio") {
    if (!data.base64) return <PreviewError message="Media could not be loaded inline." />;
    return (
      <div className={styles.mediaWrap}>
        {kind === "video" ? (
          <video className={styles.previewVideo} controls preload="metadata" src={`data:${data.mime};base64,${data.base64}`}>
            Your browser cannot play this video format.
          </video>
        ) : (
          <audio className={styles.previewAudio} controls preload="metadata" src={`data:${data.mime};base64,${data.base64}`}>
            Your browser cannot play this audio format.
          </audio>
        )}
        <FileActions path={path} labelled />
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
        <FileActions path={path} labelled />
      </div>
    );
  }

  // HTML file targets use the real Chromium live preview so relative assets,
  // SVGs, fonts and safe local JavaScript behave like the source page. If this
  // build cannot provide the loopback server, retain the safe static fallback.
  if (kind === "text" && /\.(?:html?|xhtml)$/i.test(path)) {
    return <LiveHtmlPreview path={path} content={data.content} />;
  }

  // Markdown
  if (kind === "markdown") {
    return (
      <div className={styles.markdownWrap}>
        {data.truncated && (
          <p className={styles.truncNote}>File truncated — showing first ~512 KB.</p>
        )}
        <FileActions path={path} />
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
      <FileActions path={path} />
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

function LiveHtmlPreview({ path, content }: { path: string; content: string }) {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; url: string }
    | { status: "fallback"; message: string }
  >({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    safeOpenLiveHtml(path).then((result) => {
      if (cancelled) return;
      if (result.ok) setState({ status: "ready", url: result.value.url });
      else setState({ status: "fallback", message: result.error });
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (state.status === "loading") return <LoadingShimmer />;
  if (state.status === "ready") {
    return (
      <div className={styles.liveHtmlWrap} aria-label="Live local HTML preview">
        <p className={styles.liveHtmlNote}>
          Live local preview · local assets and sandboxed page scripts · {state.url}
        </p>
        <iframe
          className={styles.htmlVisualFrame}
          src={state.url}
          title={`Live HTML preview: ${path}`}
          sandbox="allow-scripts allow-same-origin"
          referrerPolicy="no-referrer"
        />
      </div>
    );
  }

  return (
    <div className={styles.liveHtmlFallback}>
      <p className={styles.liveHtmlNote}>Live preview unavailable; showing a safe static fallback.</p>
      <p className={styles.liveHtmlError} role="status">{state.message}</p>
      <ArtifactCanvas content={content} title={path.split("/").pop() ?? path} />
    </div>
  );
}

// ── Safe artifact canvas ───────────────────────────────────────────────────

/**
 * Artifact content is untrusted model output. Keep the visual preview useful
 * while preventing it from reaching Electron APIs, the parent DOM, or remote
 * frames. The main-process readFile handler already confines the source path.
 */
function sanitizeArtifactHtml(source: string): string {
  return source
    .replace(/<\/?(?:script|iframe|frame|object|embed|portal|base)(?:\s[^>]*)?>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s+(?:src|href)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]+)/gi, "")
    .replace(/<meta[^>]+http-equiv\s*=\s*["']?refresh[^>]*>/gi, "");
}

function ArtifactCanvas({ content, title }: { content: string; title: string }) {
  const sanitized = sanitizeArtifactHtml(content);
  return (
    <div className={styles.artifactCanvas} aria-label={`Safe artifact canvas: ${title}`}>
      <div className={styles.artifactSafetyNote}>
        <ShieldCheck size={13} aria-hidden="true" />
        <span>Read-only sandboxed artifact</span>
      </div>
      <iframe
        className={styles.htmlVisualFrame}
        title={`Rendered artifact ${title}`}
        srcDoc={sanitized}
        sandbox="allow-forms"
        referrerPolicy="no-referrer"
      />
    </div>
  );
}

function ArtifactFilePreview({ path, title }: { path: string; title?: string }) {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ok"; data: ReadFileResult }
    | { status: "err"; message: string }
  >({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    safeReadFile(path).then((res) => {
      if (cancelled) return;
      setState(res.ok ? { status: "ok", data: res.value } : { status: "err", message: res.error });
    });
    return () => { cancelled = true; };
  }, [path]);

  if (state.status === "loading") return <LoadingShimmer />;
  if (state.status === "err") return <PreviewError message={state.message} />;

  const data = state.data;
  if (data.base64 && /^image\//i.test(data.mime)) {
    return (
      <div className={styles.artifactCanvas} aria-label={`Safe artifact canvas: ${title ?? path}`}>
        <div className={styles.artifactSafetyNote}>
          <ShieldCheck size={13} aria-hidden="true" />
          <span>Read-only artifact</span>
        </div>
        <img
          src={`data:${data.mime};base64,${data.base64}`}
          alt={title ?? path}
          className={styles.artifactImage}
        />
      </div>
    );
  }

  if (/html?/i.test(data.mime) || /\.(?:html?|xhtml)$/i.test(path)) {
    return <ArtifactCanvas content={data.content} title={title ?? path} />;
  }

  return (
    <div className={styles.artifactTextCanvas} aria-label={`Artifact content: ${title ?? path}`}>
      <div className={styles.artifactSafetyNote}>
        <ShieldCheck size={13} aria-hidden="true" />
        <span>Read-only artifact</span>
      </div>
      <pre className={styles.textPre}>{data.content}</pre>
    </div>
  );
}

// ── URL preview ───────────────────────────────────────────────────────────

function UrlPreview({ url }: { url: string }) {
  // Only attempt iframe for http/https.
  const safe = /^https?:\/\//i.test(url);
  const [iframeLoaded, setIframeLoaded] = useState(false);

  useEffect(() => {
    setIframeLoaded(false);
  }, [url]);

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
      <div className={styles.iframeStage}>
        {!iframeLoaded && (
          <div className={styles.iframeShimmer} aria-busy="true" aria-label="Loading page">
            <div className={`${styles.shimmerLine} ${styles.shimmerLong}`} />
            <div className={`${styles.shimmerLine} ${styles.shimmerMed}`} />
            <div className={`${styles.shimmerLine} ${styles.shimmerShort}`} />
          </div>
        )}
        <iframe
          src={url}
          className={styles.iframe}
          sandbox="allow-same-origin allow-forms"
          title={`Preview of ${url}`}
          referrerPolicy="no-referrer"
          onLoad={() => setIframeLoaded(true)}
        />
      </div>
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

// ── Live browser preview ───────────────────────────────────────────────────
//
// The agent's internal Chromium page is rendered as a visible WebContentsView
// that the BACKEND overlays onto the app window at the rect we report here.
// This component owns:
//   - a transparent placeholder div whose getBoundingClientRect() defines where
//     the backend view sits,
//   - a live url/title strip + a thin loading bar sourced from browser:state,
//   - the attach/detach lifecycle over window resize and on unmount.

interface BrowserState {
  currentUrl: string;
  title: string;
  isLoading: boolean;
  attached: boolean;
}

async function safeBrowserAttach(
  rect: { x: number; y: number; width: number; height: number },
  sessionId?: string,
): Promise<BrowserState | null> {
  try {
    const b = bridge() as unknown as {
      browser?: {
        attach: (
          rect: { x: number; y: number; width: number; height: number },
          sessionId?: string,
        ) => Promise<{ ok: boolean; error?: string; value?: BrowserState }>;
      };
    };
    if (typeof b.browser?.attach !== "function") return null;
    const res = await b.browser.attach(rect, sessionId);
    // The IPC call can return a valid state snapshot even when the backend
    // has not created the WebContentsView yet. Treat that as a retryable
    // attach failure so polling can attach immediately after browser_navigate.
    return res.ok && res.value?.attached ? res.value : null;
  } catch {
    return null;
  }
}

async function safeBrowserUpdateBounds(
  rect: { x: number; y: number; width: number; height: number },
): Promise<void> {
  try {
    const b = bridge() as unknown as {
      browser?: { updateBounds: (rect: { x: number; y: number; width: number; height: number }) => Promise<unknown> };
    };
    if (typeof b.browser?.updateBounds !== "function") return;
    await b.browser.updateBounds(rect);
  } catch {
    /* best-effort */
  }
}

async function safeBrowserState(): Promise<BrowserState | null> {
  try {
    const b = bridge() as unknown as {
      browser?: {
        state: () => Promise<{ ok: boolean; error?: string; value?: BrowserState }>;
      };
    };
    if (typeof b.browser?.state !== "function") return null;
    const result = await b.browser.state();
    return result.ok && result.value ? result.value : null;
  } catch {
    return null;
  }
}

async function safeBrowserScreenshot(): Promise<string | null> {
  try {
    const b = bridge() as unknown as {
      browser?: {
        screenshot?: (opts?: { fullPage?: boolean; quality?: number }) => Promise<{
          ok: boolean;
          error?: string;
          value?: { data: string; mimeType: string };
        }>;
      };
    };
    if (typeof b.browser?.screenshot !== "function") return null;
    const result = await b.browser.screenshot({ fullPage: false, quality: 90 });
    if (!result.ok || !result.value?.data) return null;
    return `data:${result.value.mimeType || "image/jpeg"};base64,${result.value.data}`;
  } catch {
    return null;
  }
}

async function safeBrowserDetach(): Promise<void> {
  try {
    const b = bridge() as unknown as { browser?: { detach: () => Promise<unknown> } };
    if (typeof b.browser?.detach !== "function") return;
    await b.browser.detach();
  } catch {
    /* best-effort */
  }
}

function BrowserPreview({ sessionId }: { sessionId?: string }) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<BrowserState | null>(null);
  const [screenshotData, setScreenshotData] = useState<string | null>(null);
  const [attachFailed, setAttachFailed] = useState(false);

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;

    let cancelled = false;

    // Compute the rect relative to the window content area. The backend
    // addChildView uses the same coordinate space as the renderer's CSS
    // pixels relative to the BrowserWindow content. Because the window's
    // content origin matches the renderer's top-left, getBoundingClientRect
    // against the body element gives us the correct absolute rect.
    const computeRect = (): { x: number; y: number; width: number; height: number } => {
      const r = overlay.getBoundingClientRect();
      // The x/y are relative to the viewport top-left, which IS the window
      // content area for a frameless BrowserWindow with no extra chrome above
      // the renderer. Round to integers to avoid sub-pixel jitter.
      return {
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.max(1, Math.round(r.width)),
        height: Math.max(1, Math.round(r.height)),
      };
    };

    let pollTimer: ReturnType<typeof setInterval> | null = null;

    // Attach on mount.
    void (async () => {
      const rect = computeRect();
      const attached = await safeBrowserAttach(rect, sessionId);
      if (cancelled) return;
      if (attached) {
        setState(attached);
      } else {
        // The backend may report no view yet if no browser_* tool has run.
        // We still keep the overlay mounted and poll; the next navigate will
        // lazily create the view, after which attach can be retried.
        setAttachFailed(true);
      }
      // Poll for live state (url/title/loading) at a quiet cadence.
      pollTimer = setInterval(async () => {
        if (cancelled) return;
        // If attach failed, retry it now that the backend view may exist.
        if (attachFailedRef.current) {
          const rect = computeRect();
          const reattached = await safeBrowserAttach(rect, sessionId);
          if (cancelled) return;
          if (reattached) {
            attachFailedRef.current = false;
            setAttachFailed(false);
            setState(reattached);
            return;
          }
        }
        const s = await safeBrowserState();
        if (cancelled) return;
        if (s) {
          setState(s);
          if (s.currentUrl && !s.isLoading) {
            const screenshot = await safeBrowserScreenshot();
            if (!cancelled && screenshot) setScreenshotData(screenshot);
          }
        }
      }, 800);
    })();

    // Re-send the rect on window resize so the backend overlay tracks.
    const onResize = () => {
      const rect = computeRect();
      setState((prev) => (prev && prev.attached ? null : prev));
      void safeBrowserUpdateBounds(rect);
    };
    window.addEventListener("resize", onResize);

    // Track the overlay size with a ResizeObserver too, so panel reflows
    // (e.g. the right panel opening) keep the live view aligned.
    const ro = new ResizeObserver(() => {
      const rect = computeRect();
      void safeBrowserUpdateBounds(rect);
    });
    ro.observe(overlay);

    return () => {
      cancelled = true;
      if (pollTimer) clearInterval(pollTimer);
      window.removeEventListener("resize", onResize);
      ro.disconnect();
      void safeBrowserDetach();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // A ref to track attachFailed inside the interval without re-running the
  // effect (avoids re-attaching every render).
  const attachFailedRef = useRef(attachFailed);
  useEffect(() => {
    attachFailedRef.current = attachFailed;
  }, [attachFailed]);

  const url = state?.currentUrl || "about:blank";
  const title = state?.title || "";
  const loading = state?.isLoading ?? false;

  return (
    <div className={styles.browserPreview}>
      {/* Live url/title strip */}
      <div className={styles.browserBar}>
        <Globe size={12} className={styles.browserBarIcon} aria-hidden="true" />
        <span className={styles.browserUrl} title={url}>{url}</span>
        {title && <span className={styles.browserTitle} title={title}>{title}</span>}
      </div>
      {/* Thin loading bar — visible while the page is loading. */}
      <div className={styles.browserLoadingTrack} aria-hidden={!loading}>
        {loading && <div className={styles.browserLoadingBar} />}
      </div>
      {/*
        Overlay zone: transparent and exactly the size the backend view will
        occupy. The backend WebContentsView paints ON TOP of this area in the
        window; this div only reserves the space and provides the rect.
       */}
      <div ref={overlayRef} className={styles.browserOverlay} aria-label="Live browser area">
        {screenshotData ? (
          <img
            className={styles.browserScreenshot}
            src={screenshotData}
            alt={title ? `Rendered preview: ${title}` : "Rendered browser preview"}
          />
        ) : /^https?:\/\//i.test(url) ? (
          <iframe
            className={styles.browserFallbackFrame}
            src={url}
            title="Rendered browser preview"
            sandbox="allow-scripts allow-forms allow-same-origin"
            referrerPolicy="no-referrer"
            tabIndex={-1}
          />
        ) : null}
        {attachFailed && (
          <p className={styles.browserWait}>
            Waiting for the agent to open a page…
          </p>
        )}
      </div>
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

function targetPath(target: PreviewTarget): string | null {
  return target.kind === "file" || target.kind === "artifact" || target.kind === "project" ? target.path : null;
}

// ── Component ─────────────────────────────────────────────────────────────

export function PreviewPanel({ target, onClose, onRefresh }: PreviewPanelProps) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [panelWidth, setPanelWidth] = useState(520);
  const [resizing, setResizing] = useState(false);
  const resizeState = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem("kozum.preview.width"));
      if (Number.isFinite(saved) && saved >= 360 && saved <= 960) setPanelWidth(saved);
    } catch {
      /* local storage is optional */
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem("kozum.preview.width", String(panelWidth));
    } catch {
      /* local storage is optional */
    }
  }, [panelWidth]);

  useEffect(() => {
    if (!resizing) return;
    const onMove = (event: PointerEvent) => {
      const current = resizeState.current;
      if (!current) return;
      const delta = current.startX - event.clientX;
      setPanelWidth(Math.round(Math.max(360, Math.min(960, current.startWidth + delta))));
    };
    const onUp = () => {
      resizeState.current = null;
      setResizing(false);
      document.body.style.cursor = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
    };
  }, [resizing]);

  const handleResizeStart = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    resizeState.current = { startX: event.clientX, startWidth: panelWidth };
    setResizing(true);
    document.body.style.cursor = "col-resize";
  };

  const handleRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
    onRefresh?.();
  }, [onRefresh]);

  if (!target) return null;

  const Icon = kindIcon(target);
  const title = targetTitle(target);

  const path = targetPath(target);

  return (
    <aside
      className={`${styles.panel} ${resizing ? styles.resizing : ""} kz-glass kz-anim-fade`}
      aria-label="Preview"
      key={target.kind}
      style={{ width: `${panelWidth}px`, flex: `0 0 ${panelWidth}px` }}
    >
      <button
        className={styles.resizeHandle}
        type="button"
        aria-label="Resize preview"
        title="Drag to resize preview"
        onPointerDown={handleResizeStart}
      >
        <GripVertical size={14} aria-hidden="true" />
      </button>
      {/* Header */}
      <header className={styles.header}>
        <Icon size={14} className={styles.headerIcon} aria-hidden="true" />
        <span className={styles.headerTitle} title={title}>
          {title}
        </span>
        <div className={styles.headerActions}>
          {path && <FileActions path={path} />}
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

      {/* Body — the key remounts on refresh/kind change so the crossfade
          plays each time. kz-anim-fade supplies the 220ms opacity-in. */}
      <div
        className={`${styles.body} kz-anim-fade`}
        key={`${target.kind}-${refreshKey}`}
      >
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
        {target.kind === "browser" && (
          <BrowserPreview sessionId={target.sessionId} />
        )}
        {target.kind === "artifact" && (
          <ArtifactFilePreview path={target.path} title={target.title} />
        )}
      </div>
    </aside>
  );
}
