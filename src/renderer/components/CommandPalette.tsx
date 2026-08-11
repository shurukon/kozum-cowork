/**
 * Kozum Cowork — CommandPalette.
 *
 * A modal-style search box that lets the user discover and trigger app-level
 * actions by name. Opens with Cmd/Ctrl+K, supports arrow-key navigation, and
 * closes on Escape / blur / selection.
 *
 * Commands are passed in from the parent so the palette stays presentational
 * and easy to test in isolation.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Search, CornerDownLeft } from "lucide-react";
import styles from "./CommandPalette.module.css";

export interface PaletteCommand {
  id: string;
  /** Primary label shown in the list. */
  label: string;
  /** Optional secondary line, e.g. a hint or shortcut. */
  hint?: string;
  /** Optional section header for grouping. */
  group?: string;
  /** Optional keyword list used for search matching but not rendered. */
  keywords?: string[];
  /** Run this command. The palette closes itself before invoking. */
  run: () => void;
}

interface Props {
  open: boolean;
  commands: PaletteCommand[];
  onClose: () => void;
}

export function CommandPalette({ open, commands, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Reset query and active row each time the palette opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      // Focus the input on the next tick so the element is mounted.
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [open]);

  // Filter by label + keywords + hint.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => {
      const hay = [c.label, c.hint ?? "", ...(c.keywords ?? [])].join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [commands, query]);

  // Keep active within range as the filtered list shrinks.
  useEffect(() => {
    if (active >= filtered.length) setActive(Math.max(0, filtered.length - 1));
  }, [filtered.length, active]);

  // Scroll the active row into view on movement.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const el = list.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = filtered[active];
      if (cmd) {
        onClose();
        cmd.run();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  return createPortal(
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={styles.panel}>
        <div className={styles.header}>
          <Search size={14} className={styles.searchIcon} aria-hidden={true} />
          <input
            ref={inputRef}
            type="text"
            className={styles.input}
            placeholder="Type a command…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={handleKeyDown}
            aria-label="Search commands"
            aria-controls="palette-list"
            aria-activedescendant={filtered[active] ? `palette-item-${active}` : undefined}
          />
        </div>

        <ul id="palette-list" ref={listRef} className={styles.list} role="listbox">
          {filtered.length === 0 ? (
            <li className={styles.empty}>No matching commands.</li>
          ) : (
            filtered.map((cmd, i) => (
              <li
                key={cmd.id}
                id={`palette-item-${i}`}
                role="option"
                aria-selected={i === active}
                className={`${styles.item} ${i === active ? styles.itemActive : ""}`}
                onMouseMove={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onClose();
                  cmd.run();
                }}
              >
                <span className={styles.itemLabel}>{cmd.label}</span>
                {cmd.hint && <span className={styles.itemHint}>{cmd.hint}</span>}
                {i === active && (
                  <CornerDownLeft size={12} className={styles.itemEnter} aria-hidden={true} />
                )}
              </li>
            ))
          )}
        </ul>
      </div>
    </div>,
    document.body,
  );
}
