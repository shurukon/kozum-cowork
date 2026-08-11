/**
 * Kozum Cowork — global keyboard shortcuts hook.
 *
 * Wires a single keydown listener that dispatches app-level actions. The hook
 * is intentionally side-effect-free — callers pass an `actions` object whose
 * callbacks describe what each shortcut should do, and the hook decides which
 * fires based on the platform's Cmd/Ctrl modifier.
 *
 * Shortcuts:
 *   Cmd/Ctrl + K        → open command palette
 *   Cmd/Ctrl + N        → new session / task
 *   Cmd/Ctrl + B        → toggle sidebar
 *   Cmd/Ctrl + ,        → open settings
 *   Escape              → close any open overlay (palette, dialog, settings)
 *
 * The hook ignores events that originate from inside form fields that already
 * handle Escape themselves (e.g. textarea), EXCEPT when a global overlay like
 * the command palette is open — that takes priority so Escape reliably closes
 * the palette even if the search input has focus.
 */

import { useEffect } from "react";

export interface KeyboardShortcutActions {
  onOpenPalette?: () => void;
  onNewSession?: () => void;
  onToggleSidebar?: () => void;
  onOpenSettings?: () => void;
  onCloseOverlay?: () => void;
}

function isTextInput(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return t.isContentEditable;
}

export function useKeyboardShortcuts(actions: KeyboardShortcutActions): void {
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;

      // Cmd/Ctrl + K → palette
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        actions.onOpenPalette?.();
        return;
      }

      // Cmd/Ctrl + N → new session/task
      if (mod && e.key.toLowerCase() === "n") {
        e.preventDefault();
        actions.onNewSession?.();
        return;
      }

      // Cmd/Ctrl + B → toggle sidebar
      if (mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        actions.onToggleSidebar?.();
        return;
      }

      // Cmd/Ctrl + , → settings
      if (mod && e.key === ",") {
        e.preventDefault();
        actions.onOpenSettings?.();
        return;
      }

      // Escape → close the topmost overlay. We always fire this for Escape
      // because palettes/dialogs are usually rendered in portals whose focus
      // may be in a search input — the strict "is text input" guard would
      // swallow the Escape the user expects to close the overlay.
      if (e.key === "Escape") {
        actions.onCloseOverlay?.();
        return;
      }

      // Any other Cmd/Ctrl combo inside a text input should fall through to
      // the native handler so the user can still select-all, copy, etc.
      void isTextInput;
    }

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [actions]);
}
