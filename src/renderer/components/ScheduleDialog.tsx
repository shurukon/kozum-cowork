/**
 * ScheduleDialog — real form for creating a scheduled task.
 *
 * Fields: Name, Prompt (required), Cadence (friendly picker → cron),
 * Working folder (optional). Shows live cron expression and next-run preview.
 * Pre-fillable for "Daily brief" / "Weekly review" quick-creates.
 */

import { useState } from "react";
import { AlertCircle, Folder, Loader2 } from "lucide-react";
import type { ScheduledTask } from "@shared/types.ts";
import { bridge } from "../bridge.ts";
import {
  buildCron,
  nextRunPreview,
  type CadenceKind,
  type CadenceState,
} from "../lib/cronPreview.ts";
import { Dialog } from "./Dialog.tsx";
import styles from "./ScheduleDialog.module.css";

export interface ScheduleDialogPrefill {
  name?: string;
  prompt?: string;
  cadenceKind?: CadenceKind;
  hour?: number;
  minute?: number;
  dayOfWeek?: number;
}

interface Props {
  prefill?: ScheduleDialogPrefill;
  onSave: (task: ScheduledTask) => void;
  onClose: () => void;
}

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function ScheduleDialog({ prefill, onSave, onClose }: Props) {
  const [name, setName] = useState(prefill?.name ?? "");
  const [prompt, setPrompt] = useState(prefill?.prompt ?? "");
  const [workingFolder, setWorkingFolder] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [promptError, setPromptError] = useState<string | null>(null);

  const [cadence, setCadence] = useState<CadenceState>({
    kind: prefill?.cadenceKind ?? "daily",
    hour: prefill?.hour ?? 9,
    minute: prefill?.minute ?? 0,
    dayOfWeek: prefill?.dayOfWeek ?? 1,
    customCron: "0 9 * * *",
  });

  const cronExpr = buildCron(cadence);
  const nextRunText = nextRunPreview(cronExpr);

  function handleCadenceKind(kind: CadenceKind) {
    setCadence((prev) => ({ ...prev, kind }));
  }

  function handleHour(raw: string) {
    const n = parseInt(raw, 10);
    if (isNaN(n)) return;
    setCadence((prev) => ({ ...prev, hour: Math.min(23, Math.max(0, n)) }));
  }

  function handleMinute(raw: string) {
    const n = parseInt(raw, 10);
    if (isNaN(n)) return;
    setCadence((prev) => ({ ...prev, minute: Math.min(59, Math.max(0, n)) }));
  }

  function handleDow(raw: string) {
    const n = parseInt(raw, 10);
    if (isNaN(n)) return;
    setCadence((prev) => ({ ...prev, dayOfWeek: Math.min(6, Math.max(0, n)) }));
  }

  async function pickFolder() {
    try {
      const dir = await bridge().dialog.selectFolder();
      if (dir) setWorkingFolder(dir);
    } catch {
      /* user cancelled or picker failed — silently ignore */
    }
  }

  async function handleSave() {
    setError(null);
    setPromptError(null);

    if (!prompt.trim()) {
      setPromptError("Prompt is required — describe what the agent should do.");
      return;
    }

    setBusy(true);
    try {
      const res = await bridge().schedule.create({
        name: name.trim() || "Untitled task",
        prompt: prompt.trim(),
        cron: cronExpr,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        enabled: true,
        mode: "cowork",
        projectId: null,
        workingFolder,
        selection: null,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      onSave(res.value);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const footer = (
    <>
      <button className={styles.cancelBtn} onClick={onClose} disabled={busy}>
        Cancel
      </button>
      <button
        className={styles.saveBtn}
        onClick={() => void handleSave()}
        disabled={busy}
      >
        {busy ? <Loader2 size={14} className="kz-spin" /> : "Schedule"}
      </button>
    </>
  );

  return (
    <Dialog title="New scheduled task" onClose={onClose} footer={footer}>
      {/* Name */}
      <div className={styles.field}>
        <label className={styles.label} htmlFor="sd-name">
          Name
        </label>
        <input
          id="sd-name"
          className={styles.input}
          type="text"
          value={name}
          placeholder="My scheduled task"
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
        />
      </div>

      {/* Prompt */}
      <div className={styles.field}>
        <label className={styles.label} htmlFor="sd-prompt">
          Prompt <span aria-hidden="true">*</span>
        </label>
        <textarea
          id="sd-prompt"
          className={styles.textarea}
          value={prompt}
          placeholder="Describe what the agent should do each time this task runs…"
          onChange={(e) => {
            setPrompt(e.target.value);
            if (promptError && e.target.value.trim()) setPromptError(null);
          }}
          disabled={busy}
        />
        {promptError && (
          <div className={styles.error} role="alert">
            <AlertCircle size={15} />
            <span>{promptError}</span>
          </div>
        )}
      </div>

      {/* Cadence */}
      <div className={styles.field}>
        <label className={styles.label} htmlFor="sd-cadence">
          Cadence
        </label>
        <select
          id="sd-cadence"
          className={styles.select}
          value={cadence.kind}
          onChange={(e) => handleCadenceKind(e.target.value as CadenceKind)}
          disabled={busy}
        >
          <option value="hourly">Hourly</option>
          <option value="daily">Daily at…</option>
          <option value="weekdays">Weekdays at…</option>
          <option value="weekly">Weekly on…</option>
          <option value="custom">Custom cron</option>
        </select>

        {/* Time picker for daily / weekdays */}
        {(cadence.kind === "daily" || cadence.kind === "weekdays") && (
          <div className={styles.timeRow}>
            <input
              className={styles.timeInput}
              type="number"
              min={0}
              max={23}
              value={pad(cadence.hour)}
              onChange={(e) => handleHour(e.target.value)}
              aria-label="Hour"
              disabled={busy}
            />
            <span className={styles.timeSep}>:</span>
            <input
              className={styles.timeInput}
              type="number"
              min={0}
              max={59}
              value={pad(cadence.minute)}
              onChange={(e) => handleMinute(e.target.value)}
              aria-label="Minute"
              disabled={busy}
            />
          </div>
        )}

        {/* Weekly picker */}
        {cadence.kind === "weekly" && (
          <>
            <select
              className={styles.select}
              value={cadence.dayOfWeek}
              onChange={(e) => handleDow(e.target.value)}
              aria-label="Day of week"
              disabled={busy}
            >
              {DAY_NAMES.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </select>
            <div className={styles.timeRow}>
              <input
                className={styles.timeInput}
                type="number"
                min={0}
                max={23}
                value={pad(cadence.hour)}
                onChange={(e) => handleHour(e.target.value)}
                aria-label="Hour"
                disabled={busy}
              />
              <span className={styles.timeSep}>:</span>
              <input
                className={styles.timeInput}
                type="number"
                min={0}
                max={59}
                value={pad(cadence.minute)}
                onChange={(e) => handleMinute(e.target.value)}
                aria-label="Minute"
                disabled={busy}
              />
            </div>
          </>
        )}

        {/* Custom cron input */}
        {cadence.kind === "custom" && (
          <input
            className={styles.input}
            type="text"
            value={cadence.customCron}
            placeholder="0 9 * * 1-5"
            onChange={(e) =>
              setCadence((prev) => ({ ...prev, customCron: e.target.value }))
            }
            aria-label="Custom cron expression"
            disabled={busy}
          />
        )}

        {/* Live cron + next-run preview */}
        <div className={styles.cronPreview} aria-live="polite">
          <span className={styles.cronExpr}>{cronExpr}</span>
          <span className={styles.cronSep}>·</span>
          <span className={styles.nextRunLabel}>Next: {nextRunText}</span>
        </div>
      </div>

      {/* Working folder */}
      <div className={styles.field}>
        <label className={styles.label}>Working folder (optional)</label>
        <div className={styles.folderRow}>
          <div className={styles.folderInput}>
            {workingFolder ?? "No folder selected"}
          </div>
          <button
            className={styles.folderBtn}
            onClick={() => void pickFolder()}
            disabled={busy}
            type="button"
          >
            <Folder size={13} />
            <span> Browse</span>
          </button>
        </div>
      </div>

      {/* Backend error */}
      {error && (
        <div className={styles.error} role="alert">
          <AlertCircle size={15} />
          <span>{error}</span>
        </div>
      )}
    </Dialog>
  );
}
