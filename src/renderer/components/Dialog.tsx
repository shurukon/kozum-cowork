/**
 * Shared dialog shell.
 *
 * Provides: overlay, centred card, title bar, close button, Escape to close,
 * focus trap on first focusable child, click-outside to dismiss.
 * All three feature dialogs build on this — no overlay code is duplicated.
 */

import { useEffect, useRef, type ReactNode, type PointerEvent } from "react";
import { X } from "lucide-react";
import styles from "./Dialog.module.css";

interface Props {
  title: string;
  onClose: () => void;
  /** Footer buttons rendered inside the card footer area. */
  footer?: ReactNode;
  children: ReactNode;
}

export function Dialog({ title, onClose, footer, children }: Props) {
  const cardRef = useRef<HTMLDivElement>(null);

  /* Escape to close */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /* Focus trap — move focus into the first focusable element */
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const focusable = card.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus();
  }, []);

  /* Click-outside to dismiss */
  function handleOverlayPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose();
  }

  return (
    <div
      className={styles.overlay}
      onPointerDown={handleOverlayPointerDown}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className={styles.card} ref={cardRef}>
        <div className={styles.header}>
          <h2 className={styles.title}>{title}</h2>
          <button
            className={styles.close}
            onClick={onClose}
            aria-label="Close dialog"
          >
            <X size={16} />
          </button>
        </div>

        <div className={styles.body}>{children}</div>

        {footer && <div className={styles.footer}>{footer}</div>}
      </div>
    </div>
  );
}
