/**
 * Left navigation.
 *
 * Mirrors the reference app's information architecture — a mode switch pinned
 * to the top, a short primary nav, a scrolling Recents list, and an account row
 * at the bottom — because that layout is the thing users have muscle memory
 * for. The nav items differ per mode: Code has sessions, not projects and
 * artifacts.
 */

import {
  Archive,
  Clock,
  Code2,
  FolderOpen,
  ListTodo,
  Plus,
  Shapes,
  SlidersHorizontal,
  ChevronDown,
} from "lucide-react";

import type { Mode } from "@shared/types.ts";
import styles from "./Sidebar.module.css";

export type NavKey =
  | "new"
  | "projects"
  | "artifacts"
  | "scheduled"
  | "customize";

interface Props {
  mode: Mode;
  onModeChange: (m: Mode) => void;
  active: NavKey;
  onNavigate: (k: NavKey) => void;
  recents: Array<{ id: string; title: string; group?: string }>;
  accountLabel: string;
  providerLabel: string;
}

const COWORK_NAV: Array<{ key: NavKey; label: string; icon: typeof Plus }> = [
  { key: "new", label: "New task", icon: Plus },
  { key: "projects", label: "Projects", icon: FolderOpen },
  { key: "artifacts", label: "Artifacts", icon: Shapes },
  { key: "scheduled", label: "Scheduled", icon: Clock },
  { key: "customize", label: "Customize", icon: Archive },
];

const CODE_NAV: Array<{ key: NavKey; label: string; icon: typeof Plus }> = [
  { key: "new", label: "New session", icon: Plus },
  { key: "customize", label: "Customize", icon: Archive },
];

export function Sidebar({
  mode,
  onModeChange,
  active,
  onNavigate,
  recents,
  accountLabel,
  providerLabel,
}: Props) {
  const nav = mode === "cowork" ? COWORK_NAV : CODE_NAV;

  // Recents carry an optional group label (a project or folder name). Preserve
  // first-seen order rather than sorting, so the list stays stable as the user
  // works instead of reshuffling under the cursor.
  const groups: Array<[string, typeof recents]> = [];
  for (const r of recents) {
    const key = r.group ?? "Recents";
    const found = groups.find(([g]) => g === key);
    if (found) found[1].push(r);
    else groups.push([key, [r]]);
  }

  return (
    <nav className={styles.sidebar} aria-label="Main navigation">
      <div className={styles.modeSwitch} role="tablist" aria-label="Mode">
        <button
          role="tab"
          aria-selected={mode === "cowork"}
          className={`${styles.modeBtn} ${mode === "cowork" ? styles.modeOn : ""}`}
          onClick={() => onModeChange("cowork")}
        >
          <ListTodo size={14} />
          <span>Cowork</span>
        </button>
        <button
          role="tab"
          aria-selected={mode === "code"}
          className={`${styles.modeBtn} ${mode === "code" ? styles.modeOn : ""}`}
          onClick={() => onModeChange("code")}
        >
          <Code2 size={14} />
          <span>Code</span>
        </button>
      </div>

      <ul className={styles.nav}>
        {nav.map(({ key, label, icon: Icon }) => (
          <li key={key}>
            <button
              className={`${styles.navItem} ${active === key ? styles.navOn : ""}`}
              onClick={() => onNavigate(key)}
              aria-current={active === key ? "page" : undefined}
            >
              <Icon size={15} className={styles.navIcon} />
              <span>{label}</span>
            </button>
          </li>
        ))}
      </ul>

      <div className={styles.recents}>
        {groups.map(([group, items]) => (
          <section key={group} className={styles.group}>
            <header className={styles.groupHead}>
              <span>{group}</span>
              {group === "Recents" && (
                <button className={styles.groupAction} aria-label="Filter recents">
                  <SlidersHorizontal size={13} />
                </button>
              )}
            </header>
            <ul>
              {items.map((r) => (
                <li key={r.id}>
                  <button className={styles.recent} title={r.title}>
                    <span className={styles.dot} aria-hidden />
                    <span className="kz-truncate">{r.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {recents.length === 0 && (
          <p className={styles.empty}>Your recent work will appear here.</p>
        )}
      </div>

      <button className={styles.account}>
        <img src="./icons/mark-24.png" alt="" className={styles.avatar} width={18} height={18} />
        <span className={styles.accountName}>{accountLabel}</span>
        <span className={styles.accountSep}>·</span>
        <span className={styles.accountProvider}>{providerLabel}</span>
        <ChevronDown size={14} className={styles.accountChevron} />
      </button>
    </nav>
  );
}
