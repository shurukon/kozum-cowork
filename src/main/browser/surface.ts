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
  private _didNavigateListener: ((...args: unknown[]) => void) | null = null;
  private _didStartLoadingListener: ((...args: unknown[]) => void) | null = null;
  private _didStopLoadingListener: ((...args: unknown[]) => void) | null = null;
  private _titleUpdatedListener: ((...args: unknown[]) => void) | null = null;
  private _lastTitle = "";

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
      // addChildView / removeChildView are on BaseWindow; BrowserWindow adds
      // its own members on top. The types from this Electron version don't
      // expose addChildView on BrowserWindow directly, so cast through unknown.
      (win as unknown as {
        addChildView: (v: AttachableWebContentsView) => void;
      }).addChildView(view);
    } catch {
      // addChildView may fail if the view is already a child — ignore.
    }

    view.setBounds({
      x: Math.max(0, Math.round(rect.x)),
      y: Math.max(0, Math.round(rect.y)),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
    });

    // Auto-resize so the live view tracks window size changes in sync with the
    // renderer's ResizeObserver (the renderer re-sends the rect on resize too).
    try {
      view.setAutoResize?.({ width: true, height: true });
    } catch {
      // Optional method — ignore.
    }

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

  /** Update only the rect of the already-attached view. */
  updateBounds(rect: SurfaceRect): void {
    if (!this._view) return;
    this._view.setBounds({
      x: Math.max(0, Math.round(rect.x)),
      y: Math.max(0, Math.round(rect.y)),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
    });
  }

  /** Remove the view from the window. The view is NOT destroyed (engine owns it). */
  detachFrom(win: BrowserWindow | null): void {
    if (this._view && win) {
      try {
        (win as unknown as {
          removeChildView?: (v: AttachableWebContentsView) => void;
        }).removeChildView?.(this._view);
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
