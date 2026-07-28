/**
 * Browser engine — internal Chromium session driven over CDP via Electron's
 * WebContentsView.
 *
 * Design:
 *   - BrowserBackend: injectable seam; lets tests supply a fake.
 *   - BrowserEngine: session owner + retry/timeout logic (no Electron dependency).
 *   - ElectronBrowserBackend: concrete impl; lazily imports Electron so the
 *     module loads cleanly in plain Node.
 *   - Pure exported helpers (buildSelectorScript, extractJsonScript, sanitiseUrl)
 *     are unit-testable without any runtime.
 *
 * HARD RULE: this file must NOT import "electron" at the top level.
 */

/* ===================================================== BackendUnavailableError */

export class BackendUnavailableError extends Error {
  constructor(capability: string) {
    super(
      `${capability} is unavailable outside the Kozum Cowork Electron app. ` +
        "Run this tool from within the app.",
    );
    this.name = "BackendUnavailableError";
  }
}

/* =========================================================== BrowserBackend */

export interface ScreenshotOptions {
  fullPage?: boolean;
  /** JPEG quality 1-100. */
  quality?: number;
}

export interface ScreenshotResult {
  /** base64-encoded JPEG. */
  data: string;
  mimeType: "image/jpeg";
  width: number;
  height: number;
}

export interface BrowserBackend {
  navigate(url: string): Promise<void>;
  evaluate(js: string): Promise<unknown>;
  screenshot(opts?: ScreenshotOptions): Promise<ScreenshotResult>;
  click(selectorOrCoords: string | { x: number; y: number }): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  scroll(direction: "up" | "down" | "left" | "right", amount: number): Promise<void>;
  waitFor(selectorOrMs: string | number): Promise<void>;
  content(): Promise<string>;
  close(): Promise<void>;
  currentUrl(): Promise<string>;
}

/* ========================================== pure helper — sanitiseUrl ====== */

const ALLOWED_SCHEMES = new Set(["http:", "https:", "file:", "about:"]);
const BLOCKED_SCHEME_PATTERNS = /^[\s\x00-\x1f]*(javascript|data|vbscript)\s*:/i;

/**
 * Validate a URL before handing it to the browser.
 *
 * Allows: http, https, file, about:blank.
 * Rejects: javascript:, data:, vbscript:, and mixed-case / whitespace-padded
 * variants.
 *
 * Returns the trimmed, validated URL string or throws with a descriptive message.
 */
export function sanitiseUrl(url: string): string {
  const trimmed = url.trim();

  // Fast-reject obvious injection patterns including leading whitespace tricks.
  if (BLOCKED_SCHEME_PATTERNS.test(trimmed)) {
    throw new Error(
      `Blocked URL scheme: "${trimmed.slice(0, 64)}". ` +
        "Only http, https, file, and about:blank are permitted.",
    );
  }

  // Parse to extract the protocol.
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid URL: "${trimmed.slice(0, 256)}".`);
  }

  // Normalised protocol is always lowercase and includes the colon.
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new Error(
      `Blocked URL scheme "${parsed.protocol}". ` +
        "Only http, https, file, and about:blank are permitted.",
    );
  }

  return trimmed;
}

/* =========================================== pure helper — buildSelectorScript */

/**
 * Escape a string so it can be safely embedded inside a JS single-quoted
 * string literal. Handles ', \, newlines, and nulls.
 */
function escapeJsSingleQuoted(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\0/g, "\\0");
}

/**
 * Build the JS string to be injected into the page for element interaction.
 *
 * The selector and value are escaped so that no quote in either can break
 * out of the string literal — this is injection-safe.
 *
 * @param selector  CSS selector
 * @param action    "click" | "type" | "extract"
 * @param value     Text to type (action==="type") or undefined
 */
export function buildSelectorScript(
  selector: string,
  action: "click" | "type" | "extract",
  value?: string,
): string {
  const s = escapeJsSingleQuoted(selector);

  if (action === "click") {
    return (
      `(function() {` +
      ` var el = document.querySelector('${s}');` +
      ` if (!el) throw new Error('Element not found: ' + '${s}');` +
      ` el.click();` +
      ` return true;` +
      ` })()`
    );
  }

  if (action === "type") {
    const v = escapeJsSingleQuoted(value ?? "");
    return (
      `(function() {` +
      ` var el = document.querySelector('${s}');` +
      ` if (!el) throw new Error('Element not found: ' + '${s}');` +
      ` el.focus();` +
      ` el.value = '${v}';` +
      ` el.dispatchEvent(new Event('input', { bubbles: true }));` +
      ` el.dispatchEvent(new Event('change', { bubbles: true }));` +
      ` return true;` +
      ` })()`
    );
  }

  // action === "extract"
  return (
    `(function() {` +
    ` var el = document.querySelector('${s}');` +
    ` if (!el) return null;` +
    ` return el.innerText || el.textContent || '';` +
    ` })()`
  );
}

/* ========================================= pure helper — extractJsonScript */

/**
 * Build the JS string that extracts structured data from the page based on a
 * plain-language instruction. The result is a JSON-serialisable object.
 */
export function extractJsonScript(instruction: string): string {
  const escaped = escapeJsSingleQuoted(instruction);
  return (
    `(function() {` +
    ` var instruction = '${escaped}';` +
    ` var result = {` +
    `   instruction: instruction,` +
    `   title: document.title,` +
    `   url: window.location.href,` +
    `   text: document.body ? (document.body.innerText || document.body.textContent || '') : '',` +
    `   links: Array.from(document.querySelectorAll('a[href]')).slice(0, 50).map(function(a) {` +
    `     return { text: a.innerText.trim(), href: a.href };` +
    `   }),` +
    `   headings: Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).slice(0, 20).map(function(h) {` +
    `     return { level: h.tagName.toLowerCase(), text: h.innerText.trim() };` +
    `   })` +
    ` };` +
    ` return result;` +
    ` })()`
  );
}

/* ========================================== ElectronBrowserBackend ========= */

/** Minimal shape of Electron's WebContentsView we actually use. */
interface ElectronWebContentsView {
  webContents: {
    loadURL(url: string): Promise<void>;
    goBack(): void;
    goForward(): void;
    getURL(): string;
    executeJavaScript(code: string): Promise<unknown>;
    capturePage(rect?: {
      x: number;
      y: number;
      width: number;
      height: number;
    }): Promise<{ toJPEG(q: number): Buffer; getSize(): { width: number; height: number } }>;
    insertText(text: string): Promise<void>;
  };
  setBounds(b: { x: number; y: number; width: number; height: number }): void;
  destroy(): void;
}

interface ElectronModule {
  WebContentsView: new (opts: object) => ElectronWebContentsView;
  app: { whenReady(): Promise<void> };
}

/**
 * Concrete BrowserBackend that drives Electron's WebContentsView.
 * Lazily loads Electron so this module can be imported in Node test runners
 * without crashing.
 */
export class ElectronBrowserBackend implements BrowserBackend {
  private _view: ElectronWebContentsView | null = null;
  private _electron: ElectronModule | null = null;
  private readonly _viewportWidth: number;
  private readonly _viewportHeight: number;

  constructor(viewportWidth = 1280, viewportHeight = 800) {
    this._viewportWidth = viewportWidth;
    this._viewportHeight = viewportHeight;
  }

  private async getView(): Promise<ElectronWebContentsView> {
    if (this._view) return this._view;

    if (!this._electron) {
      try {
        this._electron = (await import("electron")) as unknown as ElectronModule;
      } catch {
        throw new BackendUnavailableError("Browser");
      }
    }

    await this._electron.app.whenReady();

    const view = new this._electron.WebContentsView({});
    view.setBounds({
      x: 0,
      y: 0,
      width: this._viewportWidth,
      height: this._viewportHeight,
    });
    this._view = view;
    return view;
  }

  async navigate(url: string): Promise<void> {
    const view = await this.getView();
    await view.webContents.loadURL(url);
  }

  async evaluate(js: string): Promise<unknown> {
    const view = await this.getView();
    return view.webContents.executeJavaScript(js);
  }

  async screenshot(opts?: ScreenshotOptions): Promise<ScreenshotResult> {
    const view = await this.getView();
    const quality = Math.min(100, Math.max(1, opts?.quality ?? 85));

    let captureRect: { x: number; y: number; width: number; height: number } | undefined;

    if (opts?.fullPage) {
      const fullHeight = (await view.webContents.executeJavaScript(
        "document.body.scrollHeight",
      )) as number;
      view.setBounds({
        x: 0,
        y: 0,
        width: this._viewportWidth,
        height: fullHeight,
      });
    } else {
      captureRect = {
        x: 0,
        y: 0,
        width: this._viewportWidth,
        height: this._viewportHeight,
      };
    }

    const image = await view.webContents.capturePage(captureRect);
    const size = image.getSize();
    const data = image.toJPEG(quality).toString("base64");

    return { data, mimeType: "image/jpeg", width: size.width, height: size.height };
  }

  async click(selectorOrCoords: string | { x: number; y: number }): Promise<void> {
    const view = await this.getView();
    if (typeof selectorOrCoords === "string") {
      const script = buildSelectorScript(selectorOrCoords, "click");
      await view.webContents.executeJavaScript(script);
    } else {
      // Coords: synthesise a mouse click via JS
      const { x, y } = selectorOrCoords;
      const el = `document.elementFromPoint(${x}, ${y})`;
      await view.webContents.executeJavaScript(
        `(function(){ var e = ${el}; if(e) e.click(); return !!e; })()`,
      );
    }
  }

  async type(selector: string, text: string): Promise<void> {
    const view = await this.getView();
    const script = buildSelectorScript(selector, "type", text);
    await view.webContents.executeJavaScript(script);
  }

  async scroll(direction: "up" | "down" | "left" | "right", amount: number): Promise<void> {
    const view = await this.getView();
    const dx = direction === "left" ? -amount : direction === "right" ? amount : 0;
    const dy = direction === "up" ? -amount : direction === "down" ? amount : 0;
    await view.webContents.executeJavaScript(
      `window.scrollBy(${dx}, ${dy}); true`,
    );
  }

  async waitFor(selectorOrMs: string | number): Promise<void> {
    if (typeof selectorOrMs === "number") {
      await new Promise<void>((resolve) => setTimeout(resolve, selectorOrMs));
      return;
    }
    const view = await this.getView();
    const s = escapeJsSingleQuoted(selectorOrMs);
    await view.webContents.executeJavaScript(
      `new Promise(function(resolve, reject) {` +
        ` var el = document.querySelector('${s}');` +
        ` if (el) { resolve(null); return; }` +
        ` var observer = new MutationObserver(function() {` +
        `   el = document.querySelector('${s}');` +
        `   if (el) { observer.disconnect(); resolve(null); }` +
        ` });` +
        ` observer.observe(document.body, { childList: true, subtree: true });` +
        ` setTimeout(function() { observer.disconnect(); reject(new Error('waitFor timeout')); }, 10000);` +
        `})`,
    );
  }

  async content(): Promise<string> {
    const view = await this.getView();
    return (await view.webContents.executeJavaScript(
      "document.documentElement.outerHTML",
    )) as string;
  }

  async close(): Promise<void> {
    if (this._view) {
      this._view.destroy();
      this._view = null;
    }
  }

  async currentUrl(): Promise<string> {
    const view = await this.getView();
    return view.webContents.getURL();
  }
}

/* ================================================================ BrowserEngine */

export interface BrowserEngineOptions {
  /** Maximum ms to wait for a single operation. Default: 30_000. */
  timeoutMs?: number;
  /** Number of times to retry a transient backend error. Default: 2. */
  retries?: number;
}

/**
 * BrowserEngine owns a browser session and adds:
 *   - sanitiseUrl call before navigate (so javascript: URLs never reach the backend).
 *   - per-operation timeout via AbortSignal.
 *   - configurable retry on transient errors.
 */
export class BrowserEngine {
  private readonly _backend: BrowserBackend;
  private readonly _timeoutMs: number;
  private readonly _retries: number;

  constructor(backend: BrowserBackend, opts: BrowserEngineOptions = {}) {
    this._backend = backend;
    this._timeoutMs = opts.timeoutMs ?? 30_000;
    this._retries = opts.retries ?? 2;
  }

  /* ------------------------------------------------- internal primitives -- */

  private async withTimeout<T>(label: string, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${this._timeoutMs}ms`));
      }, this._timeoutMs);

      fn().then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });
  }

  private async withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this._retries; attempt++) {
      try {
        return await this.withTimeout(label, fn);
      } catch (e) {
        lastError = e;
        // Don't retry on non-transient or fatal errors.
        if (e instanceof BackendUnavailableError) throw e;
        if (attempt < this._retries) {
          await new Promise<void>((r) => setTimeout(r, 300 * (attempt + 1)));
        }
      }
    }
    throw lastError;
  }

  /* -------------------------------------------------------- public API -- */

  async navigate(url: string): Promise<void> {
    const safe = sanitiseUrl(url); // throws on javascript:/data:/vbscript:
    await this.withRetry("navigate", () => this._backend.navigate(safe));
  }

  async evaluate(js: string): Promise<unknown> {
    return this.withRetry("evaluate", () => this._backend.evaluate(js));
  }

  async screenshot(opts?: ScreenshotOptions): Promise<ScreenshotResult> {
    return this.withRetry("screenshot", () => this._backend.screenshot(opts));
  }

  async click(selectorOrCoords: string | { x: number; y: number }): Promise<void> {
    return this.withRetry("click", () => this._backend.click(selectorOrCoords));
  }

  async type(selector: string, text: string): Promise<void> {
    return this.withRetry("type", () => this._backend.type(selector, text));
  }

  async scroll(direction: "up" | "down" | "left" | "right", amount: number): Promise<void> {
    return this.withRetry("scroll", () => this._backend.scroll(direction, amount));
  }

  async waitFor(selectorOrMs: string | number): Promise<void> {
    return this.withRetry("waitFor", () => this._backend.waitFor(selectorOrMs));
  }

  async content(): Promise<string> {
    return this.withRetry("content", () => this._backend.content());
  }

  async close(): Promise<void> {
    await this._backend.close();
  }

  async currentUrl(): Promise<string> {
    return this.withRetry("currentUrl", () => this._backend.currentUrl());
  }

  async extract(instruction: string): Promise<unknown> {
    const script = extractJsonScript(instruction);
    return this.evaluate(script);
  }
}
