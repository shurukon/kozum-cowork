/**
 * Left navigation (rework).
 *
 * Changes:
 * - Dead "Filter recents" button replaced by a real in-place text filter.
 * - Each recent row gets a hover "⋯" menu (ConversationMenu) with
 *   Open, Rename, Branch, Archive, Delete.
 * - Mode switch, primary nav, and account row are preserved.
 */

import { useState, useRef, useEffect } from "react";
import {
  Archive,
  Clock,
  Code2,
  FolderOpen,
  ListTodo,
  Plus,
  MoreHorizontal,
  Search,
  ChevronDown,
} from "lucide-react";

import type { Mode } from "@shared/types.ts";
import { ConversationMenu } from "./ConversationMenu.tsx";
import styles from "./Sidebar.module.css";

export type NavKey =
  | "new"
  | "projects"
  | "artifacts"
  | "scheduled"
  | "customize";

// ── Recent item shape ──────────────────────────────────────────────────────

export interface RecentItem {
  id: string;
  title: string;
  group?: string;
}

// ── Per-recent callbacks ───────────────────────────────────────────────────

export interface ConversationCallbacks {
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onBranch: (id: string) => void;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
}

// ── Props ──────────────────────────────────────────────────────────────────

export interface SidebarProps {
  mode: Mode;
  onModeChange: (m: Mode) => void;
  active: NavKey;
  onNavigate: (k: NavKey) => void;
  recents: RecentItem[];
  accountLabel: string;
  providerLabel: string;
  /** The account row is the primary way into Settings. */
  onAccountClick: () => void;
  onSelectRecent: (id: string) => void;
  /** ConversationMenu callbacks — wired by App to bridge.sessions.* */
  conversationCallbacks: ConversationCallbacks;
}

// ── Nav definitions ────────────────────────────────────────────────────────

const COWORK_NAV: Array<{ key: NavKey; label: string; icon: typeof Plus }> = [
  { key: "new", label: "New task", icon: Plus },
  { key: "projects", label: "Projects", icon: FolderOpen },
  { key: "scheduled", label: "Scheduled", icon: Clock },
  { key: "customize", label: "Customize", icon: Archive },
];

const CODE_NAV: Array<{ key: NavKey; label: string; icon: typeof Plus }> = [
  { key: "new", label: "New session", icon: Plus },
  { key: "customize", label: "Customize", icon: Archive },
];

// ── RecentRow ──────────────────────────────────────────────────────────────

interface RecentRowProps {
  item: RecentItem;
  onSelect: () => void;
  callbacks: ConversationCallbacks;
}

function RecentRow({ item, onSelect, callbacks }: RecentRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const rowRef = useRef<HTMLLIElement>(null);

  // Close menu on outside click (ConversationMenu handles its own outside click,
  // but we keep this as a backup for the trigger button).
  useEffect(() => {
    if (!menuOpen) return;
    function handler(e: MouseEvent) {
      if (rowRef.current && !rowRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  return (
    <li ref={rowRef} className={styles.recentRow}>
      <button
        className={styles.recent}
        title={item.title}
        onClick={onSelect}
      >
        <span className={styles.dot} aria-hidden />
        <span className="kz-truncate">{item.title}</span>
      </button>

      <button
        className={`${styles.menuTrigger} ${menuOpen ? styles.menuTriggerActive : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          setMenuOpen((v) => !v);
        }}
        aria-label={`Options for ${item.title}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
      >
        <MoreHorizontal size={13} />
      </button>

      {menuOpen && (
        <ConversationMenu
          currentTitle={item.title}
          onOpen={() => { callbacks.onOpen(item.id); setMenuOpen(false); }}
          onRename={(title) => { callbacks.onRename(item.id, title); setMenuOpen(false); }}
          onBranch={() => { callbacks.onBranch(item.id); setMenuOpen(false); }}
          onArchive={() => { callbacks.onArchive(item.id); setMenuOpen(false); }}
          onDelete={() => { callbacks.onDelete(item.id); setMenuOpen(false); }}
          onClose={() => setMenuOpen(false)}
        />
      )}
    </li>
  );
}

// ── Sidebar ────────────────────────────────────────────────────────────────

export function Sidebar({
  mode,
  onModeChange,
  active,
  onNavigate,
  recents,
  accountLabel,
  providerLabel,
  onAccountClick,
  onSelectRecent,
  conversationCallbacks,
}: SidebarProps) {
  const nav = mode === "cowork" ? COWORK_NAV : CODE_NAV;
  const [filterQuery, setFilterQuery] = useState("");

  // Filter recents in-place by title (case-insensitive).
  const filteredRecents = filterQuery.trim()
    ? recents.filter((r) =>
        r.title.toLowerCase().includes(filterQuery.toLowerCase()),
      )
    : recents;

  // Group filtered recents, preserving first-seen order.
  const groups: Array<[string, RecentItem[]]> = [];
  for (const r of filteredRecents) {
    const key = r.group ?? "Recents";
    const found = groups.find(([g]) => g === key);
    if (found) found[1].push(r);
    else groups.push([key, [r]]);
  }

  return (
    <nav className={styles.sidebar} aria-label="Main navigation">
      {/* Mode switch */}
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

      {/* Primary nav */}
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

      {/* Recents */}
      <div className={styles.recents}>
        {/* Filter input (replaces the dead SlidersHorizontal button) */}
        <div className={styles.filterRow}>
          <Search size={12} className={styles.filterIcon} aria-hidden />
          <input
            className={styles.filterInput}
            type="search"
            placeholder="Filter recents"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            aria-label="Filter recents"
          />
        </div>

        {groups.map(([group, items]) => (
          <section key={group} className={styles.group}>
            <header className={styles.groupHead}>
              <span>{group}</span>
            </header>
            <ul>
              {items.map((r) => (
                <RecentRow
                  key={r.id}
                  item={r}
                  onSelect={() => onSelectRecent(r.id)}
                  callbacks={conversationCallbacks}
                />
              ))}
            </ul>
          </section>
        ))}

        {filteredRecents.length === 0 && filterQuery ? (
          <p className={styles.empty}>No matches for &quot;{filterQuery}&quot;.</p>
        ) : recents.length === 0 ? (
          <p className={styles.empty}>Your recent work will appear here.</p>
        ) : null}
      </div>

      {/* Account row — opens Settings */}
      <button className={styles.account} onClick={onAccountClick} title="Settings">
        <img src="./icons/mark-24.png" alt="" className={styles.avatar} width={18} height={18} />
        <span className={styles.accountName}>{accountLabel}</span>
        <span className={styles.accountSep}>·</span>
        <span className={styles.accountProvider}>{providerLabel}</span>
        <ChevronDown size={14} className={styles.accountChevron} />
      </button>
    </nav>
  );
}
