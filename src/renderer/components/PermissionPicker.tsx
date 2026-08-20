import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Check, ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import type { PermissionMode } from "@shared/types.ts";
import styles from "./PermissionPicker.module.css";

interface ModeOption {
  value: PermissionMode;
  number: number;
  labelKey: string;
  descKey: string;
  danger?: boolean;
}

const OPTIONS: ModeOption[] = [
  { value: "accept_all", number: 1, labelKey: "permission.modeAcceptAll", descKey: "permission.modeAcceptAllDesc", danger: true },
  { value: "accept_edits", number: 2, labelKey: "permission.modeAcceptEdits", descKey: "permission.modeAcceptEditsDesc" },
  { value: "ask", number: 3, labelKey: "permission.modeAsk", descKey: "permission.modeAskDesc" },
  { value: "reject", number: 4, labelKey: "permission.modeReject", descKey: "permission.modeRejectDesc" },
];

interface Props {
  value: PermissionMode;
  onChange: (mode: PermissionMode) => void;
}

const ARM_TIMEOUT_MS = 3000;

export function PermissionPicker({ value, onChange }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [armedAcceptAll, setArmedAcceptAll] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = OPTIONS.find((o) => o.value === value) ?? OPTIONS[1]!;

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setArmedAcceptAll(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      const n = Number(e.key);
      if (n >= 1 && n <= OPTIONS.length) {
        const option = OPTIONS[n - 1];
        if (option) select(option.value);
      }
      if (e.key === "Escape") {
        setOpen(false);
        setArmedAcceptAll(false);
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, armedAcceptAll]);

  useEffect(() => () => {
    if (armTimerRef.current) clearTimeout(armTimerRef.current);
  }, []);

  function select(mode: PermissionMode) {
    if (mode === "accept_all" && value !== "accept_all") {
      if (!armedAcceptAll) {
        setArmedAcceptAll(true);
        if (armTimerRef.current) clearTimeout(armTimerRef.current);
        armTimerRef.current = setTimeout(() => setArmedAcceptAll(false), ARM_TIMEOUT_MS);
        return;
      }
      setArmedAcceptAll(false);
      if (armTimerRef.current) clearTimeout(armTimerRef.current);
      onChange(mode);
      setOpen(false);
      return;
    }
    setArmedAcceptAll(false);
    if (armTimerRef.current) clearTimeout(armTimerRef.current);
    onChange(mode);
    setOpen(false);
  }

  const isAcceptAll = value === "accept_all";
  return (
    <div className={styles.anchor} ref={ref}>
      <button
        className={styles.trigger}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={t("permission.modeTitle")}
      >
        {isAcceptAll ? <ShieldAlert size={13} className={styles.triggerDanger} /> : value === "reject" ? <ShieldX size={13} /> : <ShieldCheck size={13} />}
        <span>{t(current.labelKey)}</span>
        <span className={styles.triggerBadge}>{current.number}</span>
      </button>

      {open && (
        <div className={styles.popover} role="listbox" aria-label={t("permission.modeTitle")}>
          {OPTIONS.map((option) => {
            const isSelected = option.value === value;
            const isArmed = option.value === "accept_all" && armedAcceptAll && !isSelected;
            return (
              <button
                key={option.value}
                role="option"
                aria-selected={isSelected}
                className={`${styles.option} ${isSelected ? styles.optionActive : ""} ${option.danger ? styles.optionDanger : ""} ${isArmed ? styles.optionArmed : ""}`}
                onClick={() => select(option.value)}
              >
                <span className={styles.badge}>{option.number}</span>
                <span className={styles.info}>
                  <span className={styles.label}>{t(option.labelKey)}</span>
                  <span className={styles.desc}>{isArmed ? `${t("common.confirm")} — ${t("common.yes")} ?` : t(option.descKey)}</span>
                </span>
                {isSelected && <Check size={13} className={styles.tick} />}
              </button>
            );
          })}
          <p className={styles.footerHint}>{t(current.descKey)}</p>
        </div>
      )}
    </div>
  );
}
