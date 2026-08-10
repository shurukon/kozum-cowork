/**
 * Kozum Cowork — empty state placeholder.
 *
 * A small, reusable empty-state component used by list pages and panels.
 */

import type { ReactNode } from "react";
import styles from "./Empty.module.css";

interface Props {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function Empty({ icon, title, description, action }: Props) {
  return (
    <div className={styles.wrap}>
      {icon && <div className={styles.icon}>{icon}</div>}
      <p className={styles.title}>{title}</p>
      {description && <p className={styles.desc}>{description}</p>}
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );
}
