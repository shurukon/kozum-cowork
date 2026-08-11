/**
 * Kozum Cowork — PermissionPicker popover.
 *
 * Renders a popover above the Code-mode composer showing the four permission
 * modes with number badges. Matches the reference product's interaction model:
 * clicking the trigger opens/closes the list, clicking an option selects it
 * and closes, pressing 1–4 selects via keyboard shortcut.
 *
 * Safety: the "Bypass permissions" mode requires a two-click confirmation.
 * The first click arms the option (shows a red "click again to confirm"
 * hint); the second click within a short window actually applies the mode.
 * Selecting any other option resets the armed state.
 *
 * Usage:
 *   <PermissionPicker value={permissionMode} onChange={setPermissionMode} />
 */

import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Check, ShieldCheck, ShieldAlert } from "lucide-react";
import type { PermissionMode } from "@shared/types.ts";
import styles from "./PermissionPicker.module.css";

// ── Option definitions ─────────────────────────────────────────────────────

interface ModeOption {
  value: PermissionMode;
  number: number;
  labelKey: string;
  descKey: string;
  danger?: boolean;
}

const OPTIONS: ModeOption[] = [
  { value: "manual", number: 1, labelKey: "permission.modeManual", descKey: "permission.modeManualDesc" },
  { value: "accept_edits", number: 2, labelKey: "permission.modeAcceptEdits", descKey: "permission.modeAcceptEditsDesc" },
  { value: "plan", number: 3, labelKey: "permission.modePlan", descKey: "permission.modePlanDesc" },
  { value: "bypass_permissions", number: 4, labelKey: "permission.modeBypass", descKey: "permission.modeBypassDesc", danger: true },
];

// ── Component ──────────────────────────────────────────────────────────────

interface Props {
  value: PermissionMode;
  onChange: (mode: PermissionMode) => void;
}

/** How long the "armed" confirmation state stays valid (ms). */
const ARM_TIMEOUT_MS = 3000;

export function PermissionPicker({ value, onChange }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [armedBypass, setArmedBypass] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const current = OPTIONS.find((o) => o.value === value) ?? OPTIONS[0]!;

  // Close on outside click.
  useEffect(() => {
    if (!open) return;

    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setArmedBypass(false);
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
          select(opt.value);
        }
      }
      if (e.key === "Escape") {
        setOpen(false);
        setArmedBypass(false);
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, armedBypass]);

  useEffect(() => {
    return () => {
      if (armTimerRef.current) clearTimeout(armTimerRef.current);
    };
  }, []);

  function select(mode: PermissionMode) {
    if (mode === "bypass_permissions" && value !== "bypass_permissions") {
      if (!armedBypass) {
        // First click: arm the confirmation. The option re-renders with a
        // danger-styled "click again to confirm" hint; the second click within
        // ARM_TIMEOUT_MS actually applies the mode.
        setArmedBypass(true);
        if (armTimerRef.current) clearTimeout(armTimerRef.current);
        armTimerRef.current = setTimeout(() => setArmedBypass(false), ARM_TIMEOUT_MS);
        return;
      }
      // Second click: confirm and apply.
      setArmedBypass(false);
      if (armTimerRef.current) clearTimeout(armTimerRef.current);
      onChange(mode);
      setOpen(false);
      return;
    }
    // Any non-bypass selection (or re-selecting bypass when already bypass):
    // reset the armed state and apply immediately.
    setArmedBypass(false);
    if (armTimerRef.current) clearTimeout(armTimerRef.current);
    onChange(mode);
    setOpen(false);
  }

  return (
    <div className={styles.anchor} ref={ref}>
      <button
        className={styles.trigger}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={t("permission.modeTitle")}
      >
        {value === "bypass_permissions" ? (
          <ShieldAlert size={13} className={styles.triggerDanger} />
        ) : (
          <ShieldCheck size={13} />
        )}
        <span>{t(current.labelKey)}</span>
        <span className={styles.triggerBadge}>{current.number}</span>
      </button>

      {open && (
        <div
          className={styles.popover}
          role="listbox"
          aria-label={t("permission.modeTitle")}
        >
          {OPTIONS.map((opt) => {
            const isSelected = opt.value === value;
            const isArmed = opt.danger && armedBypass && !isSelected;
            return (
              <button
                key={opt.value}
                role="option"
                aria-selected={isSelected}
                className={`${styles.option} ${isSelected ? styles.optionActive : ""} ${opt.danger ? styles.optionDanger : ""} ${isArmed ? styles.optionArmed : ""}`}
                onClick={() => select(opt.value)}
              >
                <span className={styles.badge}>{opt.number}</span>
                <span className={styles.info}>
                  <span className={styles.label}>{t(opt.labelKey)}</span>
                  <span className={styles.desc}>
                    {isArmed
                      ? t("common.confirm") + " — " + t("common.yes") + "?"
                      : t(opt.descKey)}
                  </span>
                </span>
                {isSelected && <Check size={13} className={styles.tick} />}
              </button>
            );
          })}
          <p className={styles.footerHint}>
            {value === "bypass_permissions"
              ? t("permission.modeBypassDesc")
              : t("permission.modeManualDesc")}
          </p>
        </div>
      )}
    </div>
  );
}
