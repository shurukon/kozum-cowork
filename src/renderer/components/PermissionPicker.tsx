/**
 * Kozum Cowork — PermissionPicker popover.
 *
 * Renders a popover above the Code-mode composer showing the four permission
 * modes with number badges. Matches the reference product's interaction model:
 * clicking the trigger opens/closes the list, clicking an option selects it
 * and closes, pressing 1–4 selects via keyboard shortcut.
 *
 * Usage:
 *   <PermissionPicker value={permissionMode} onChange={setPermissionMode} />
 *
 * NOT wired into App.tsx — drop it above the Code composer when App is updated.
 */

import { useState, useEffect, useRef } from "react";
import { Check, ShieldCheck } from "lucide-react";
import type { PermissionMode } from "@shared/types.ts";
import styles from "./PermissionPicker.module.css";

// ── Option definitions ─────────────────────────────────────────────────────

interface ModeOption {
  value: PermissionMode;
  number: number;
  label: string;
  desc: string;
}

const OPTIONS: ModeOption[] = [
  {
    value: "manual",
    number: 1,
    label: "Manual",
    desc: "Confirm every action before it runs.",
  },
  {
    value: "accept_edits",
    number: 2,
    label: "Accept edits",
    desc: "File edits apply automatically; shell commands still ask.",
  },
  {
    value: "plan",
    number: 3,
    label: "Plan",
    desc: "Read-only — no file writes or shell execution.",
  },
  {
    value: "bypass_permissions",
    number: 4,
    label: "Bypass permissions",
    desc: "No confirmations — use with caution in trusted projects.",
  },
];

// ── Component ──────────────────────────────────────────────────────────────

interface Props {
  value: PermissionMode;
  onChange: (mode: PermissionMode) => void;
}

export function PermissionPicker({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const current = OPTIONS.find((o) => o.value === value) ?? OPTIONS[0]!;

  // Close on outside click.
  useEffect(() => {
    if (!open) return;

    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // Number-key shortcuts while the popover is open.
  useEffect(() => {
    if (!open) return;

    function handleKey(e: KeyboardEvent) {
      const n = Number(e.key);
      if (n >= 1 && n <= OPTIONS.length) {
        const opt = OPTIONS[n - 1];
        if (opt) {
          onChange(opt.value);
          setOpen(false);
        }
      }
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onChange]);

  return (
    <div className={styles.anchor} ref={ref}>
      <button
        className={styles.trigger}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Permission mode"
      >
        <ShieldCheck size={13} />
        <span>{current.label}</span>
        <span className={styles.triggerBadge}>{current.number}</span>
      </button>

      {open && (
        <div
          className={styles.popover}
          role="listbox"
          aria-label="Permission mode"
        >
          {OPTIONS.map((opt) => (
            <button
              key={opt.value}
              role="option"
              aria-selected={opt.value === value}
              className={`${styles.option} ${opt.value === value ? styles.optionActive : ""}`}
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
            >
              <span className={styles.badge}>{opt.number}</span>
              <span className={styles.info}>
                <span className={styles.label}>{opt.label}</span>
                <span className={styles.desc}>{opt.desc}</span>
              </span>
              <Check size={13} className={styles.tick} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
