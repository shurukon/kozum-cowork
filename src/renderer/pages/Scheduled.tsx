/**
 * Kozum Cowork — scheduled tasks page.
 *
 * Title, sort, new-task button, search, a notice about keep-awake with a
 * toggle, and a clock-glyph empty state with quick-create actions.
 */

import { useState } from "react";
import { Clock, Plus, Search, SortAsc, ToggleLeft, ToggleRight, CalendarDays, RefreshCcw } from "lucide-react";
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
}

export function Scheduled({
  tasks,
  keepAwake,
  onToggleKeepAwake,
  onNewTask,
  onDailyBrief,
  onWeeklyReview,
}: Props) {
  const [search, setSearch] = useState("");
  const [sort] = useState<"next_run" | "name">("next_run");

  const filtered = tasks
    .filter((t) => t.name.toLowerCase().includes(search.toLowerCase()))
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
        <h1 className={styles.title}>Scheduled tasks</h1>
        <div className={styles.headerRight}>
          <button className={styles.sortBtn}>
            <SortAsc size={14} />
            <span>Sort by Next run</span>
          </button>
          <button className={styles.newBtn} onClick={onNewTask}>
            <Plus size={14} />
            <span>New task</span>
          </button>
        </div>
      </div>

      {/* Search */}
      <div className={styles.searchRow}>
        <Search size={14} className={styles.searchIcon} />
        <input
          className={styles.search}
          placeholder="Search tasks…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search scheduled tasks"
        />
      </div>

      {/* Keep-awake notice */}
      <div className={styles.notice}>
        <Clock size={14} className={styles.noticeIcon} />
        <p className={styles.noticeText}>
          Scheduled tasks only run while your computer is awake and online.
        </p>
        <button
          className={styles.keepAwakeBtn}
          onClick={onToggleKeepAwake}
          aria-pressed={keepAwake}
          aria-label="Keep awake"
        >
          {keepAwake ? (
            <ToggleRight size={20} className={styles.toggleOn} />
          ) : (
            <ToggleLeft size={20} className={styles.toggleOff} />
          )}
          <span>Keep awake</span>
        </button>
      </div>

      {/* List or empty state */}
      {filtered.length === 0 ? (
        <div className={styles.emptyWrap}>
          <Empty
            icon={<Clock size={24} />}
            title={search ? "No matching tasks" : "Create your first scheduled task"}
            description={
              search
                ? "Try a different search term."
                : "Automate recurring work by scheduling tasks to run on a cron schedule."
            }
          />
          {!search && (
            <div className={styles.quickActions}>
              <button className={styles.quickBtn} onClick={onDailyBrief}>
                <CalendarDays size={15} />
                <span>Daily brief</span>
              </button>
              <button className={styles.quickBtn} onClick={onWeeklyReview}>
                <RefreshCcw size={15} />
                <span>Weekly review</span>
              </button>
            </div>
          )}
        </div>
      ) : (
        <ul className={styles.list}>
          {filtered.map((t) => (
            <li key={t.id} className={styles.taskCard}>
              <div className={styles.taskInfo}>
                <span className={styles.taskName}>{t.name}</span>
                <span className={styles.taskCron}>{t.cron}</span>
              </div>
              <div className={styles.taskMeta}>
                {t.nextRunAt && (
                  <span className={styles.taskNext}>
                    Next: {new Date(t.nextRunAt).toLocaleString()}
                  </span>
                )}
                <span
                  className={`${styles.taskStatus} ${
                    t.enabled ? styles.taskStatusOn : styles.taskStatusOff
                  }`}
                >
                  {t.enabled ? "Active" : "Paused"}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
