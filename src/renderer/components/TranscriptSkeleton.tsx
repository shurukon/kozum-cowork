/**
 * Kozum Cowork — TranscriptSkeleton.
 *
 * Shimmer-loading placeholder shown while a session's transcript is being
 * fetched from the backend. The number of rows is configurable; each row
 * mimics the visual rhythm of a user bubble + an assistant reply.
 */

import styles from "./TranscriptSkeleton.module.css";

interface Props {
  /** Number of user/assistant row pairs to render. Defaults to 4. */
  rows?: number;
  /** Optional className to position the skeleton within a parent. */
  className?: string;
}

export function TranscriptSkeleton({ rows = 4, className }: Props) {
  const safeRows = Math.max(1, Math.min(10, rows));
  return (
    <div
      className={`${styles.host} ${className ?? ""}`}
      role="status"
      aria-busy="true"
      aria-label="Loading transcript"
    >
      {Array.from({ length: safeRows }).map((_, i) => (
        <div key={i} className={styles.row}>
          <div className={styles.userBubble}>
            <div className={`${styles.line} ${styles.lineUser}`} />
            <div className={`${styles.line} ${styles.lineUser} ${styles.short}`} />
          </div>
          <div className={styles.assistantBlock}>
            <div className={styles.toolCard} />
            <div className={`${styles.line} ${styles.lineAssistant}`} />
            <div className={`${styles.line} ${styles.lineAssistant}`} />
            <div className={`${styles.line} ${styles.lineAssistant} ${styles.short}`} />
          </div>
        </div>
      ))}
    </div>
  );
}
