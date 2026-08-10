/**
 * Cowork home screen.
 *
 * Deliberately sparse: a greeting, the composer, and a folder affordance. The
 * composer itself is the shared ComposerBar (passed in as `composerSlot`) so the
 * three-selector provider/key/model switching lives here exactly as it does in
 * Code mode — the model control no longer opens Settings.
 */

import type { ReactNode } from "react";
import { ChevronDown, FolderOpen } from "lucide-react";

import styles from "./HomeView.module.css";

interface Props {
  userName: string;
  /** The shared ComposerBar, wired by App. */
  composerSlot: ReactNode;
  /** Opens the folder picker for an ad-hoc working folder. */
  onPickFolder: () => void;
  /** Current working-folder label, or null when none is set. */
  folderLabel: string | null;
}

export function HomeView({ userName, composerSlot, onPickFolder, folderLabel }: Props) {
  const heading = userName
    ? `What can I take off your plate, ${userName}?`
    : "What can I take off your plate?";

  return (
    <div className={`${styles.wrap} kz-dotfield kz-dotfield-fade`}>
      <div className={styles.inner}>
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

        <p className={styles.sub}>
          <a href="#" onClick={(e) => e.preventDefault()}>
            Learn how to use Kozum safely.
          </a>
        </p>

        <div className={styles.composerShell}>
          {composerSlot}

          <button className={styles.folder} onClick={onPickFolder}>
            <FolderOpen size={14} />
            <span>{folderLabel ?? "Work in a project or folder"}</span>
            <ChevronDown size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
