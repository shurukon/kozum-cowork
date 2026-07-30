/**
 * Kozum Cowork — Code-mode home screen (rework).
 *
 * Reference (Claude Code): greeting "What's up next, <name>?" + folder row +
 * composer at the bottom. No stats grid, no activity heat-map.
 *
 * The composer is passed in as a composerSlot ReactNode so this component
 * does not depend on ComposerBar's internals.
 *
 * Layout (top to bottom):
 *   1. Greeting heading
 *   2. Folder row: "Local" chip | folder name chips | "+ Add another folder" button
 *   3. composerSlot (ComposerBar or any ReactNode)
 */

import type { ReactNode } from "react";
import { FolderOpen, Plus } from "lucide-react";
import styles from "./CodeHome.module.css";

// ── Props ─────────────────────────────────────────────────────────────────

export interface CodeHomeProps {
  userName: string;
  /** Absolute folder paths currently open. May be empty. */
  folders: string[];
  /** Called when the user clicks "+ Add another folder". */
  onAddFolder: () => void;
  /** Called when the user clicks an existing folder chip. */
  onOpenFolder: (path: string) => void;
  /** The full composer bar — owned by App/ComposerBar, slotted in here. */
  composerSlot: ReactNode;
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Return the last path segment (folder name) from an absolute path. */
function folderName(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? path;
}

// ── Component ─────────────────────────────────────────────────────────────

export function CodeHome({
  userName,
  folders,
  onAddFolder,
  onOpenFolder,
  composerSlot,
}: CodeHomeProps) {
  const heading = userName
    ? `What's up next, ${userName}?`
    : "What are we building?";

  return (
    <div className={`${styles.wrap} kz-dotfield kz-dotfield-fade`}>
      <div className={styles.inner}>
        {/* Greeting */}
        <h1 className={styles.heading}>
          <img
            src="./icons/mark-32.png"
            alt=""
            width={26}
            height={26}
            className={styles.mark}
          />
          <span>{heading}</span>
        </h1>

        {/* Folder row */}
        <div className={styles.folderRow} role="list" aria-label="Open folders">
          {/* "Local" chip — always shown */}
          <span className={styles.chipLocal} role="listitem" aria-label="Local filesystem">
            <FolderOpen size={12} aria-hidden />
            Local
          </span>

          {/* One chip per open folder */}
          {folders.map((path) => (
            <button
              key={path}
              className={styles.chipFolder}
              role="listitem"
              title={path}
              onClick={() => onOpenFolder(path)}
              aria-label={`Open folder ${folderName(path)}`}
            >
              {folderName(path)}
            </button>
          ))}

          {/* Add another folder */}
          <button
            className={styles.chipAdd}
            onClick={onAddFolder}
            aria-label="Add another folder"
            title="Add another folder"
          >
            <Plus size={13} aria-hidden />
            <span>Add another folder</span>
          </button>
        </div>

        {/* Composer (slotted) */}
        <div className={styles.composerArea}>{composerSlot}</div>
      </div>
    </div>
  );
}
