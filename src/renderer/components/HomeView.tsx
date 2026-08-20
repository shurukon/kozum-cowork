/**
 * Cowork home screen.
 *
 * This view is intentionally Cowork-specific. CodeHome remains a separate
 * component and keeps its existing presentation and behavior.
 */

import type { ReactNode } from "react";

import styles from "./HomeView.module.css";

interface Props {
  userName: string;
  /** The Cowork-specific ComposerBar, wired by App. */
  composerSlot: ReactNode;
  /** Kept as a compatibility prop for the existing folder bridge wiring. */
  onPickFolder: () => void;
  /** Current Cowork working-folder label, or null when none is set. */
  folderLabel: string | null;
}

export function HomeView({ composerSlot }: Props) {
  return (
    <section className={`${styles.wrap} kz-cowork-home`} aria-label="Cowork workspace">
      <div className={styles.inner}>
        <div className={styles.hero}>
          <div className={styles.brandLine}>
            <span className={styles.brandMark} aria-hidden="true">
              K
            </span>
            <span className={styles.brandName}>Kozum AI</span>
          </div>
          <h1 className={styles.heading}>Kozum AI</h1>
          <p className={styles.sub}>Where knowledge meets intelligence.</p>
        </div>

        <div className={styles.composerShell}>{composerSlot}</div>
      </div>
    </section>
  );
}
