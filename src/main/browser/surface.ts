/**
 * BrowserSurface — owns the *visible* WebContentsView docked into the app
 * BrowserWindow so the user can watch the agent's browser activity live.
 *
 * DESIGN:
 *   - The BrowserEngine/Backend create and drive a WebContentsView headlessly.
 *   - BrowserSurface takes that same view, re-parents it (addChildView) into the
 *     app's main BrowserWindow, and positions it over the PreviewPanel rect.
 *   - On detach, it removes the view from the window (removeChildView) but does
 *     NOT destroy it — the engine still owns it for screenshot/evaluate.
 *
 * HARD RULE: this module MAY import "electron" at top level because it is only
 * ever loaded from the main process during a browser:attach IPC call, never
 * during a Node test import. The engine.ts HARD RULE is preserved because the
 * engine never imports this module; the IPC handler imports it on demand.
 */

import type { BrowserWindow } from "electron";

/** Minimal view shape we need from the engine's backend. */
export interface AttachableWebContentsView {
  webContents: {
    getURL(): string;
    on(event: string, listener: (...args: unknown[]) => void): void;
    removeListener?(event: string, listener: (...args: unknown[]) => void): void;
    isDestroyed?(): boolean;
  };
  setBounds(b: { x: number; y: number; width: number; height: number }): void;
  setAutoResize?(opts: { width: boolean; height: boolean }): void;
}

/** Screen rect the renderer requests for the live browser overlay. */
export interface SurfaceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** State snapshot the renderer polls via browser:state. */
export interface BrowserState {
  currentUrl: string;
  title: string;
  isLoading: boolean;
  attached: boolean;
}

/**
 * Manages a single visible WebContentsView attached to the app window.
 * Singleton per app lifetime — the engine only ever has one active browser
 * session, so a second attach REPLACES the first (matches headless behavior).
 */
export class BrowserSurface {
  private _window: BrowserWindow | null = null;
  private _view: AttachableWebContentsView | null = null;
  private _loadingState = false;
  /**
   * R6 fix — monotonic attach generation. A late-resolving `browser:attach`
   * (the lazy WebContentsView creation can take tens of ms) used to re-parent
   * an orphaned native view AFTER the renderer had already detached while
   * unmounting. That orphan painted over the whole app and nothing could
   * remove it short of a restart. Any detach/new attach bumps the sequence so
   * stale in-flight attaches become no-ops.
   */
  private _attachSeq = 0;
  private _didNavigateListener: ((...args: unknown[]) => void) | null = null;
  private _didStartLoadingListener: ((...args: unknown[]) => void) | null = null;
  private _didStopLoadingListener: ((...args: unknown[]) => void) | null = null;
  private _titleUpdatedListener: ((...args: unknown[]) => void) | null = null;
  private _lastTitle = "";

  /** Clamp a requested rect to the host window's content bounds; rejects NaN. */
  private clampRect(win: BrowserWindow | null, rect: SurfaceRect): SurfaceRect {
    const num = (v: unknown): number =>
      typeof v === "number" && Number.isFinite(v) ? v : 0;
    let x = Math.round(num(rect.x));
    let y = Math.round(num(rect.y));
    let width = Math.max(1, Math.round(num(rect.width)));
    let height = Math.max(1, Math.round(num(rect.height)));

    const cb = (win as unknown as {
      getContentBounds?: () => { width: number; height: number };
    }).getContentBounds?.();
    if (cb && cb.width > 0 && cb.height > 0) {
      width = Math.min(width, cb.width);
      height = Math.min(height, cb.height);
      x = Math.min(Math.max(0, x), Math.max(0, cb.width - Math.min(width, cb.width)));
      y = Math.min(Math.max(0, y), Math.max(0, cb.height - Math.min(height, cb.height)));
    }
    return { x, y, width, height };
  }

  /**
   * Attach the shared engine view once its lazy creation resolves, unless a
   * newer attach/detach superseded this request meanwhile (see _attachSeq).
   */
  async attachWhenReady(
    win: BrowserWindow | null,
    ensureView: () => Promise<AttachableWebContentsView | null>,
    rect: SurfaceRect,
  ): Promise<BrowserState> {
    const seq = ++this._attachSeq;
    let view: AttachableWebContentsView | null = null;
    try {
      view = await ensureView();
    } catch {
      view = null;
    }
    if (seq !== this._attachSeq || !win || !view) {
      // Superseded by a detach/attach that arrived while we were awaiting —
      // do NOT touch the native view tree.
      return this.getState();
    }
    this.attachTo(win, view, rect);
    return this.getState();
  }

  /** Attach the given view to the app window at the specified rect. */
  attachTo(
    win: BrowserWindow | null,
    view: AttachableWebContentsView | null,
    rect: SurfaceRect,
  ): void {
    // If the window is null (e.g. running under Node test), this is a no-op.
    if (!win || !view) return;

    // If a different view is already attached, detach it first.
    if (this._view && this._view !== view) {
      this.detachFrom(this._window);
    }

    this._window = win;
    this._view = view;

    try {
      // Electron's BrowserWindow exposes the View tree through contentView.
      // addChildView is not a BrowserWindow method in current Electron builds;
      // calling win.addChildView silently leaves the native browser invisible.
      const host = win as unknown as {
        contentView?: {
          addChildView?: (v: AttachableWebContentsView) => void;
        };
        addChildView?: (v: AttachableWebContentsView) => void;
      };
      if (typeof host.contentView?.addChildView === "function") {
        host.contentView.addChildView(view);
      } else {
        host.addChildView?.(view);
      }
    } catch {
      // addChildView may fail if the view is already a child — ignore.
    }

    // R6: clamped to window bounds; NO setAutoResize — the renderer already
    // tracks panel/window resizes via ResizeObserver + explicit resize events,
    // and Electron's auto-resize deltas were drifting the view over the whole
    // UI after a couple of resizes.
    view.setBounds(this.clampRect(win, rect));

    // Track loading state + title for browser:state polling.
    try {
      const wc = view.webContents;
      this._didNavigateListener = (..._args: unknown[]) => {
        // Navigation completed.
      };
      this._didStartLoadingListener = () => {
        this._loadingState = true;
      };
      this._didStopLoadingListener = () => {
        this._loadingState = false;
      };
      this._titleUpdatedListener = (...args: unknown[]) => {
        const title = typeof args[1] === "string" ? args[1] : "";
        this._lastTitle = title;
      };

      wc.on("did-start-loading", this._didStartLoadingListener);
      wc.on("did-stop-loading", this._didStopLoadingListener);
      wc.on("did-navigate", this._didNavigateListener);
      try {
        wc.on("page-title-updated", this._titleUpdatedListener);
      } catch {
        // page-title-updated may not exist on this webContents shape — ignore.
      }

      this._lastTitle = "";
    } catch {
      // webContents event wiring is best-effort.
    }
  }

  /** Update only the rect of the already-attached view (clamped to the window). */
  updateBounds(rect: SurfaceRect): void {
    if (!this._view) return;
    this._view.setBounds(this.clampRect(this._window, rect));
  }

  /** Remove the view from the window. The view is NOT destroyed (engine owns it). */
  detachFrom(win: BrowserWindow | null): void {
    // Invalidate any in-flight attach immediately.
    this._attachSeq += 1;

    if (this._view && win) {
      try {
        const host = win as unknown as {
          contentView?: {
            removeChildView?: (v: AttachableWebContentsView) => void;
          };
          removeChildView?: (v: AttachableWebContentsView) => void;
        };
        if (typeof host.contentView?.removeChildView === "function") {
          host.contentView.removeChildView(this._view);
        } else {
          host.removeChildView?.(this._view);
        }
      } catch {
        // Best-effort removal.
      }
    }

    // Unsubscribe from webContents events if the view is still alive.
    if (this._view) {
      try {
        const wc = this._view.webContents;
        const off = wc.removeListener?.bind(wc);
        if (off && !wc.isDestroyed?.()) {
          off("did-start-loading", this._didStartLoadingListener!);
          off("did-stop-loading", this._didStopLoadingListener!);
          off("did-navigate", this._didNavigateListener!);
          try {
            off("page-title-updated", this._titleUpdatedListener!);
          } catch {
            // Best-effort — the event may not have been registered.
          }
        }
      } catch {
        // Best-effort cleanup.
      }
    }

    this._view = null;
    this._window = null;
    this._loadingState = false;
    this._didNavigateListener = null;
    this._didStartLoadingListener = null;
    this._didStopLoadingListener = null;
    this._titleUpdatedListener = null;
  }

  /** Return the current state snapshot for the renderer. */
  getState(): BrowserState {
    let currentUrl = "";
    if (this._view) {
      try {
        currentUrl = this._view.webContents.getURL();
      } catch {
        currentUrl = "";
      }
    }
    return {
      currentUrl,
      title: this._lastTitle,
      isLoading: this._loadingState,
      attached: this._view !== null,
    };
  }

  /** Whether a view is currently attached. */
  isAttached(): boolean {
    return this._view !== null;
  }
}
