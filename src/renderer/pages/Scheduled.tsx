/**
 * Kozum Cowork — scheduled tasks page.
 *
 * Lists every scheduled task with its prompt, last/next run, run count, mode,
 * timezone and working folder. Per-row actions: edit, delete, run-now, pause
 * and resume. The page also surfaces the "keep awake" scheduler setting.
 *
 * All copy is sourced from the i18n catalog so the page localises cleanly.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Clock,
  Plus,
  Search,
  SortAsc,
  ToggleLeft,
  ToggleRight,
  CalendarDays,
  RefreshCcw,
  Play,
  Pause,
  Pencil,
  Trash2,
} from "lucide-react";
import type { ScheduledTask } from "@shared/types.ts";
import { Empty } from "../components/Empty.tsx";
import styles from "./Scheduled.module.css";

interface Props {
  tasks: ScheduledTask[];
  keepAwake: boolean;
  onToggleKeepAwake: () => void;
  onNewTask: () => void;
  onDailyBrief: () => void;
  onWeeklyReview: () => void;
  /** Edit a task — the parent opens the ScheduleDialog in edit mode. */
  onEdit?: (task: ScheduledTask) => void;
  /** Delete a task by id. */
  onDelete?: (id: string) => void;
  /** Run a task immediately. */
  onRunNow?: (id: string) => void;
  /** Pause (disable) a task. */
  onPause?: (id: string) => void;
  /** Resume (enable) a task. */
  onResume?: (id: string) => void;
}

type SortKey = "next_run" | "name";

function formatDate(ms: number | undefined, fallback: string): string {
  if (ms === undefined) return fallback;
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return fallback;
  }
}

export function Scheduled({
  tasks,
  keepAwake,
  onToggleKeepAwake,
  onNewTask,
  onDailyBrief,
  onWeeklyReview,
  onEdit,
  onDelete,
  onRunNow,
  onPause,
  onResume,
}: Props) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("next_run");

  const filtered = tasks
    .filter((task) =>
      task.name.toLowerCase().includes(search.toLowerCase()) ||
      task.prompt.toLowerCase().includes(search.toLowerCase()),
    )
    .sort((a, b) => {
      if (sort === "next_run") {
        const an = a.nextRunAt ?? Infinity;
        const bn = b.nextRunAt ?? Infinity;
        return an - bn;
      }
      return a.name.localeCompare(b.name);
    });

  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.header}>
        <h1 className={styles.title}>{t("scheduled.title")}</h1>
        <div className={styles.headerRight}>
          <button
            className={styles.sortBtn}
            onClick={() => setSort((s) => (s === "next_run" ? "name" : "next_run"))}
            aria-label={t("scheduled.sortBy")}
          >
            <SortAsc size={14} />
            <span>
              {t("scheduled.sortBy")}:{" "}
              {sort === "next_run" ? t("scheduled.nextRun") : t("scheduled.name")}
            </span>
          </button>
          <button className={styles.newBtn} onClick={onNewTask}>
            <Plus size={14} />
            <span>{t("scheduled.newTask")}</span>
          </button>
        </div>
      </div>

      {/* Search */}
      <div className={styles.searchRow}>
        <Search size={14} className={styles.searchIcon} />
        <input
          className={styles.search}
          placeholder={t("scheduled.title")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search scheduled tasks"
        />
      </div>

      {/* Keep-awake notice */}
      <div className={styles.notice}>
        <Clock size={14} className={styles.noticeIcon} />
        <p className={styles.noticeText}>{t("scheduled.keepAwake")}</p>
        <button
          className={styles.keepAwakeBtn}
          onClick={onToggleKeepAwake}
          aria-pressed={keepAwake}
          aria-label={t("scheduled.keepAwake")}
        >
          {keepAwake ? (
            <ToggleRight size={20} className={styles.toggleOn} />
          ) : (
            <ToggleLeft size={20} className={styles.toggleOff} />
          )}
          <span>{t("scheduled.keepAwake")}</span>
        </button>
      </div>

      {/* List or empty state */}
      {filtered.length === 0 ? (
        <div className={styles.emptyWrap}>
          <Empty
            icon={<Clock size={24} />}
            title={search ? t("scheduled.empty") : t("scheduled.empty")}
            description={
              search
                ? t("scheduled.empty")
                : t("scheduled.empty")
            }
          />
          {!search && (
            <div className={styles.quickActions}>
              <button className={styles.quickBtn} onClick={onDailyBrief}>
                <CalendarDays size={15} />
                <span>{t("scheduled.dailyBrief")}</span>
              </button>
              <button className={styles.quickBtn} onClick={onWeeklyReview}>
                <RefreshCcw size={15} />
                <span>{t("scheduled.weeklyReview")}</span>
              </button>
            </div>
          )}
        </div>
      ) : (
        <ul className={styles.list}>
          {filtered.map((task) => {
            const isActive = task.enabled;
            const hadError = task.lastStatus === "failed";
            const neverRun = task.lastRunAt === undefined;
            const statusLabel = !isActive
              ? t("scheduled.statusPaused")
              : hadError
                ? t("scheduled.statusError")
                : neverRun
                  ? t("scheduled.statusNever")
                  : t("scheduled.statusActive");
            const statusClass = !isActive
              ? styles.taskStatusOff
              : hadError
                ? styles.taskStatusError
                : styles.taskStatusOn;
            return (
              <li key={task.id} className={styles.taskCard}>
                <div className={styles.taskInfo}>
                  <div className={styles.taskHeader}>
                    <span className={styles.taskName}>{task.name}</span>
                    <span className={`${styles.taskStatus} ${statusClass}`}>{statusLabel}</span>
                  </div>
                  {task.prompt && (
                    <p className={styles.taskPrompt} title={task.prompt}>
                      {task.prompt}
                    </p>
                  )}
                  <div className={styles.taskMetaRow}>
                    <span className={styles.taskCron} title={t("scheduled.cron")}>
                      <Clock size={11} aria-hidden={true} /> {task.cron}
                    </span>
                    <span className={styles.taskMode}>{task.mode}</span>
                    {task.timezone && (
                      <span className={styles.taskTz}>{task.timezone}</span>
                    )}
                    {task.workingFolder && (
                      <span className={styles.taskFolder} title={task.workingFolder}>
                        {task.workingFolder}
                      </span>
                    )}
                  </div>
                  <div className={styles.taskMetaRow}>
                    <span className={styles.taskMetaItem}>
                      {t("scheduled.nextRun")}: {formatDate(task.nextRunAt, t("scheduled.statusNever"))}
                    </span>
                    <span className={styles.taskMetaItem}>
                      {t("scheduled.lastRun")}: {formatDate(task.lastRunAt, t("scheduled.statusNever"))}
                    </span>
                    <span className={styles.taskMetaItem}>
                      {t("scheduled.runCount")}: {task.runCount}
                    </span>
                  </div>
                </div>
                <div className={styles.taskActions}>
                  {isActive ? (
                    <button
                      className={styles.actionBtn}
                      onClick={() => onPause?.(task.id)}
                      title={t("scheduled.pause")}
                      aria-label={t("scheduled.pause")}
                    >
                      <Pause size={13} />
                    </button>
                  ) : (
                    <button
                      className={styles.actionBtn}
                      onClick={() => onResume?.(task.id)}
                      title={t("scheduled.resume")}
                      aria-label={t("scheduled.resume")}
                    >
                      <Play size={13} />
                    </button>
                  )}
                  <button
                    className={styles.actionBtn}
                    onClick={() => onRunNow?.(task.id)}
                    title={t("scheduled.runNow")}
                    aria-label={t("scheduled.runNow")}
                  >
                    <RefreshCcw size={13} />
                  </button>
                  {onEdit && (
                    <button
                      className={styles.actionBtn}
                      onClick={() => onEdit(task)}
                      title={t("scheduled.edit")}
                      aria-label={t("scheduled.edit")}
                    >
                      <Pencil size={13} />
                    </button>
                  )}
                  {onDelete && (
                    <button
                      className={`${styles.actionBtn} ${styles.actionDanger}`}
                      onClick={() => {
                        if (confirm(t("scheduled.deleteConfirm"))) onDelete(task.id);
                      }}
                      title={t("scheduled.delete")}
                      aria-label={t("scheduled.delete")}
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
