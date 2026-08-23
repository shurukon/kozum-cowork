import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Check, ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import type { PermissionMode } from "@shared/types.ts";
import styles from "./PermissionPicker.module.css";

export interface ModeOption {
  value: PermissionMode;
  labelKey?: string;
  /** Inline label for callers that don't route through i18n. */
  label?: string;
  descKey?: string;
  desc?: string;
  danger?: boolean;
}

const OPTIONS: ModeOption[] = [
  { value: "bypass_permissions", labelKey: "permission.modeBypassPermissions", descKey: "permission.modeBypassPermissionsDesc", danger: true },
  { value: "plan", labelKey: "permission.modePlan", descKey: "permission.modePlanDesc" },
  { value: "accept_edits", labelKey: "permission.modeAcceptEdits", descKey: "permission.modeAcceptEditsDesc" },
  { value: "ask_permission", labelKey: "permission.modeAskPermission", descKey: "permission.modeAskPermissionDesc" },
];

/**
 * Cowork's two postures (confirmed product decision): Auto approve runs
 * everything; Ask for dangerous actions prompts only for irreversible or
 * destructive tools.
 */
export const COWORK_OPTIONS: ModeOption[] = [
  {
    value: "bypass_permissions",
    labelKey: "permission.coworkAutoApprove",
    descKey: "permission.coworkAutoApproveDesc",
    danger: true,
  },
  {
    value: "ask_dangerous",
    labelKey: "permission.coworkAskDangerous",
    descKey: "permission.coworkAskDangerousDesc",
  },
];

interface Props {
  value: PermissionMode;
  onChange: (mode: PermissionMode) => void;
  /** Mode list to present; defaults to Code's four-mode picker. */
  options?: ModeOption[];
}

const ARM_TIMEOUT_MS = 3000;

export function PermissionPicker({ value, onChange, options = OPTIONS }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [armedBypass, setArmedBypass] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasBypass = options.some((o) => o.value === "bypass_permissions");
  const current = options.find((o) => o.value === value) ?? options[0]!;
  const currentLabel = current.label ?? t(current.labelKey ?? "");
  const currentDesc = current.desc ?? t(current.descKey ?? "");

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

  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      const n = Number(e.key);
      if (n >= 1 && n <= options.length) {
        const option = options[n - 1];
        if (option) select(option.value);
      }
      if (e.key === "Escape") {
        setOpen(false);
        setArmedBypass(false);
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, armedBypass, options]);

  useEffect(() => () => {
    if (armTimerRef.current) clearTimeout(armTimerRef.current);
  }, []);

  function select(mode: PermissionMode) {
    if (mode === "bypass_permissions" && hasBypass && value !== "bypass_permissions") {
      if (!armedBypass) {
        setArmedBypass(true);
        if (armTimerRef.current) clearTimeout(armTimerRef.current);
        armTimerRef.current = setTimeout(() => setArmedBypass(false), ARM_TIMEOUT_MS);
        return;
      }
      setArmedBypass(false);
      if (armTimerRef.current) clearTimeout(armTimerRef.current);
      onChange(mode);
      setOpen(false);
      return;
    }
    setArmedBypass(false);
    if (armTimerRef.current) clearTimeout(armTimerRef.current);
    onChange(mode);
    setOpen(false);
  }

  const isBypass = value === "bypass_permissions";
  return (
    <div className={styles.anchor} ref={ref}>
      <button
        className={styles.trigger}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={t("permission.modeTitle")}
      >
        {isBypass ? <ShieldAlert size={13} className={styles.triggerDanger} /> : value === "plan" ? <ShieldX size={13} /> : <ShieldCheck size={13} />}
        <span>{currentLabel}</span>
        <span className={styles.triggerBadge}>{options.findIndex((o) => o.value === value) + 1 || ""}</span>
      </button>

      {open && (
        <div className={styles.popover} role="listbox" aria-label={t("permission.modeTitle")}>
          {options.map((option, index) => {
            const isSelected = option.value === value;
            const isArmed = option.value === "bypass_permissions" && armedBypass && !isSelected;
            const label = option.label ?? t(option.labelKey ?? "");
            const desc = option.desc ?? t(option.descKey ?? "");
            return (
              <button
                key={option.value}
                role="option"
                aria-selected={isSelected}
                className={`${styles.option} ${isSelected ? styles.optionActive : ""} ${option.danger ? styles.optionDanger : ""} ${isArmed ? styles.optionArmed : ""}`}
                onClick={() => select(option.value)}
              >
                <span className={styles.badge}>{index + 1}</span>
                <span className={styles.info}>
                  <span className={styles.label}>{label}</span>
                  <span className={styles.desc}>{isArmed ? `${t("common.confirm")} — ${t("common.yes")} ?` : desc}</span>
                </span>
                {isSelected && <Check size={13} className={styles.tick} />}
              </button>
            );
          })}
          <p className={styles.footerHint}>{currentDesc}</p>
        </div>
      )}
    </div>
  );
}

export default PermissionPicker;
