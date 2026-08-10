/**
 * Kozum Cowork — ConversationMenu.
 *
 * Small popover attached to each recent conversation row.
 * Actions: Open, Rename (inline), Branch, Archive, Delete (with inline confirm).
 * Keyboard-navigable; closes on Escape or click-outside.
 */

import { useState, useEffect, useRef } from "react";
import {
  ExternalLink,
  Pencil,
  GitBranch,
  Archive,
  Trash2,
  Check,
  X,
} from "lucide-react";
import styles from "./ConversationMenu.module.css";

// ── Props ──────────────────────────────────────────────────────────────────

export interface ConversationMenuProps {
  onOpen: () => void;
  onRename: (title: string) => void;
  onBranch: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onClose: () => void;
  /** Current title so the rename input is pre-populated. */
  currentTitle: string;
}

// ── Component ──────────────────────────────────────────────────────────────

type Step = "menu" | "rename" | "confirm-archive" | "confirm-delete";

export function ConversationMenu({
  onOpen,
  onRename,
  onBranch,
  onArchive,
  onDelete,
  onClose,
  currentTitle,
}: ConversationMenuProps) {
  const [step, setStep] = useState<Step>("menu");
  const [renameValue, setRenameValue] = useState(currentTitle);
  const ref = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Click-outside to close
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  // Escape to go back or close
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (step !== "menu") {
          setStep("menu");
        } else {
          onClose();
        }
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [step, onClose]);

  // Focus rename input when entering rename step
  useEffect(() => {
    if (step === "rename") {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [step]);

  function commitRename() {
    const v = renameValue.trim();
    if (v && v !== currentTitle) {
      onRename(v);
    }
    onClose();
  }

  function commitArchive() {
    onArchive();
    onClose();
  }

  function commitDelete() {
    onDelete();
    onClose();
  }

  return (
    <div ref={ref} className={styles.menu} role="menu" aria-label="Conversation options">
      {step === "menu" && (
        <>
          <button
            className={styles.item}
            role="menuitem"
            onClick={() => { onOpen(); onClose(); }}
          >
            <ExternalLink size={13} className={styles.icon} />
            Open
          </button>
          <button
            className={styles.item}
            role="menuitem"
            onClick={() => setStep("rename")}
          >
            <Pencil size={13} className={styles.icon} />
            Rename
          </button>
          <button
            className={styles.item}
            role="menuitem"
            onClick={() => { onBranch(); onClose(); }}
          >
            <GitBranch size={13} className={styles.icon} />
            Branch
          </button>
          <div className={styles.divider} aria-hidden />
          <button
            className={styles.item}
            role="menuitem"
            onClick={() => setStep("confirm-archive")}
          >
            <Archive size={13} className={styles.icon} />
            Archive
          </button>
          <button
            className={`${styles.item} ${styles.itemDanger}`}
            role="menuitem"
            onClick={() => setStep("confirm-delete")}
          >
            <Trash2 size={13} className={styles.icon} />
            Delete
          </button>
        </>
      )}

      {step === "rename" && (
        <div className={styles.renameStep}>
          <input
            ref={renameInputRef}
            className={styles.renameInput}
            type="text"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            placeholder="New title"
            aria-label="New conversation title"
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
            }}
          />
          <div className={styles.stepActions}>
            <button
              className={styles.stepBtn}
              onClick={() => setStep("menu")}
              aria-label="Cancel rename"
            >
              <X size={13} />
            </button>
            <button
              className={`${styles.stepBtn} ${styles.stepBtnConfirm}`}
              onClick={commitRename}
              aria-label="Confirm rename"
              disabled={!renameValue.trim()}
            >
              <Check size={13} />
            </button>
          </div>
        </div>
      )}

      {step === "confirm-archive" && (
        <div className={styles.confirmStep}>
          <span className={styles.confirmText}>Archive this conversation?</span>
          <div className={styles.stepActions}>
            <button
              className={styles.stepBtn}
              onClick={() => setStep("menu")}
              aria-label="Cancel"
            >
              <X size={13} />
            </button>
            <button
              className={`${styles.stepBtn} ${styles.stepBtnConfirm}`}
              onClick={commitArchive}
              aria-label="Confirm archive"
            >
              <Check size={13} />
            </button>
          </div>
        </div>
      )}

      {step === "confirm-delete" && (
        <div className={styles.confirmStep}>
          <span className={styles.confirmText}>Delete permanently?</span>
          <div className={styles.stepActions}>
            <button
              className={styles.stepBtn}
              onClick={() => setStep("menu")}
              aria-label="Cancel"
            >
              <X size={13} />
            </button>
            <button
              className={`${styles.stepBtn} ${styles.stepBtnDanger}`}
              onClick={commitDelete}
              aria-label="Confirm delete"
            >
              <Trash2 size={13} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
