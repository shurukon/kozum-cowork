/**
 * Kozum Cowork — ComposerBar.
 *
 * Shared composer used by ChatView (and optionally HomeView).
 *
 * Features:
 * - Auto-growing textarea (max 260px).
 * - Enter = send, Shift+Enter = newline, IME-safe (no send during composition).
 * - "+" opens AddMenu popover (not a file dialog directly).
 * - SelectorBar for provider/key/model switching.
 * - Optional permissionSlot (Code mode passes a PermissionPicker node).
 * - While a turn runs: sweep line at composer bottom edge + Stop button.
 * - Textarea is disabled while busy.
 */

import {
  useRef,
  useState,
  useCallback,
  type KeyboardEvent,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { ArrowUp, Plus, Square } from "lucide-react";
import type { ModelSelection, ProviderPreset, ApiKeyEntry, ModelInfo } from "@shared/types.ts";
import { AddMenu, type AddMenuKind } from "./AddMenu.tsx";
import { SelectorBar } from "./SelectorBar.tsx";
import styles from "./ComposerBar.module.css";

// ── Props ──────────────────────────────────────────────────────────────────

export interface ComposerBarProps {
  /** Whether the agent is currently running. */
  busy: boolean;
  /** Called with the trimmed message text when the user submits. */
  onSend: (text: string) => void;
  /** Called when the user presses the Stop button. */
  onCancel: () => void;
  /**
   * Called when the user picks an AddMenu item.
   * Parent decides what each kind does (e.g. files→dialog.selectFiles).
   */
  onAttach: (kind: AddMenuKind) => void;

  // SelectorBar props
  selection: ModelSelection;
  presets: ProviderPreset[];
  keysByProvider: Record<string, ApiKeyEntry[]>;
  modelsByProvider: Record<string, ModelInfo[]>;
  onSelectionChange: (next: ModelSelection) => void;
  onRefreshModels: (providerId: string) => Promise<void>;

  /** Optional slot — Code mode injects <PermissionPicker />; Cowork omits. */
  permissionSlot?: ReactNode;

  /** Placeholder text when idle. */
  placeholder?: string;
}

// ── Component ──────────────────────────────────────────────────────────────

export function ComposerBar({
  busy,
  onSend,
  onCancel,
  onAttach,
  selection,
  presets,
  keysByProvider,
  modelsByProvider,
  onSelectionChange,
  onRefreshModels,
  permissionSlot,
  placeholder = "Message…",
}: ComposerBarProps) {
  const [value, setValue] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const plusBtnRef = useRef<HTMLButtonElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const canSend = value.trim().length > 0 && !busy;

  // ── Auto-grow textarea ─────────────────────────────────────────────────

  const autoGrow = useCallback((el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, []);

  function handleChange(e: ChangeEvent<HTMLTextAreaElement>) {
    setValue(e.target.value);
    autoGrow(e.target);
  }

  // ── Submit ─────────────────────────────────────────────────────────────

  function submit() {
    const text = value.trim();
    if (!text || busy) return;
    onSend(text);
    setValue("");
    if (taRef.current) {
      taRef.current.style.height = "auto";
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // IME guard: never send mid-composition (Arabic, CJK, etc.)
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  // ── Add menu ───────────────────────────────────────────────────────────

  function handlePick(kind: AddMenuKind) {
    onAttach(kind);
    setMenuOpen(false);
  }

  return (
    <div ref={wrapRef} className={styles.wrap}>
      {/* In-flight sweep line at the bottom edge while running */}
      {busy && (
        <div className={styles.inflightBar} aria-hidden={true}>
          <div className={styles.inflightBarInner} />
        </div>
      )}

      <div className={styles.composer}>
        {/* Textarea */}
        <textarea
          ref={taRef}
          className={styles.input}
          placeholder={busy ? "Waiting for agent…" : placeholder}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          rows={1}
          disabled={busy}
          spellCheck={false}
          aria-label="Message"
          aria-multiline={true}
        />

        {/* Bottom toolbar row */}
        <div className={styles.row}>
          {/* "+" button that opens AddMenu */}
          <div className={styles.plusWrap}>
            <button
              ref={plusBtnRef}
              className={styles.plus}
              aria-label="Add attachment"
              title="Attach files, connectors, skills, or plugins"
              onClick={() => setMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              disabled={busy}
            >
              <Plus size={16} />
            </button>

            {menuOpen && (
              <AddMenu
                onPick={handlePick}
                onClose={() => setMenuOpen(false)}
                triggerRef={plusBtnRef}
              />
            )}
          </div>

          {/* Permission slot (Code mode only) */}
          {permissionSlot && (
            <div className={styles.permSlot}>{permissionSlot}</div>
          )}

          {/* Right group: selector bar + send/stop */}
          <div className={styles.rowRight}>
            <SelectorBar
              selection={selection}
              presets={presets}
              keysByProvider={keysByProvider}
              modelsByProvider={modelsByProvider}
              onChange={onSelectionChange}
              onRefreshModels={onRefreshModels}
            />

            {busy ? (
              <button
                className={styles.stop}
                onClick={onCancel}
                aria-label="Stop generation"
              >
                <Square size={12} />
              </button>
            ) : (
              <button
                className={styles.send}
                onClick={submit}
                disabled={!canSend}
                aria-label="Send message"
              >
                <ArrowUp size={15} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
