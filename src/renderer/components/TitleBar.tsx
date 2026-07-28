/**
 * Frameless-window title bar.
 *
 * The whole strip is a drag region except the controls, which opt out via
 * `.kz-no-drag`. Getting that inversion right matters: if the buttons stay
 * draggable the user can never click them, which is the classic frameless bug.
 */

import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Menu,
  Minus,
  PanelLeft,
  Search,
  Square,
  X,
} from "lucide-react";

import styles from "./TitleBar.module.css";

interface Props {
  onToggleSidebar: () => void;
  sidebarOpen: boolean;
}

export function TitleBar({ onToggleSidebar, sidebarOpen }: Props) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    // The bridge may be absent when the renderer runs outside Electron
    // (component previews, tests), so every call is guarded.
    return window.kozum?.window.onState((s) => setMaximized(s.maximized));
  }, []);

  return (
    <header className={`${styles.bar} kz-drag`}>
      <div className={`${styles.left} kz-no-drag`}>
        <button className={styles.icon} title="Menu" aria-label="Menu">
          <Menu size={16} />
        </button>
        <button
          className={styles.icon}
          onClick={onToggleSidebar}
          title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          aria-label="Toggle sidebar"
          aria-pressed={sidebarOpen}
        >
          <PanelLeft size={16} />
        </button>
        <button className={styles.icon} title="Search" aria-label="Search">
          <Search size={16} />
        </button>
        <span className={styles.divider} />
        <button className={styles.icon} title="Back" aria-label="Back" disabled>
          <ArrowLeft size={16} />
        </button>
        <button className={styles.icon} title="Forward" aria-label="Forward" disabled>
          <ArrowRight size={16} />
        </button>
      </div>

      <div className={styles.spacer} />

      <div className={`${styles.controls} kz-no-drag`}>
        <button
          className={styles.ctl}
          onClick={() => window.kozum?.window.minimize()}
          aria-label="Minimize"
        >
          <Minus size={15} />
        </button>
        <button
          className={styles.ctl}
          onClick={() => window.kozum?.window.maximize()}
          aria-label={maximized ? "Restore" : "Maximize"}
        >
          <Square size={12} />
        </button>
        <button
          className={`${styles.ctl} ${styles.close}`}
          onClick={() => window.kozum?.window.close()}
          aria-label="Close"
        >
          <X size={16} />
        </button>
      </div>
    </header>
  );
}
