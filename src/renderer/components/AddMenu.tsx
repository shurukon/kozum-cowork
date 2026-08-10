/**
 * Kozum Cowork — "+" AddMenu popover.
 *
 * A keyboard-navigable popover listing attach options: Files, Connectors,
 * Skills, Plugins. Clicking "+" in ComposerBar opens this instead of a dialog.
 * The parent wires each option (onPick callback).
 *
 * Behaviour:
 * - Click-outside closes.
 * - Escape closes and returns focus to the trigger.
 * - ArrowUp/ArrowDown navigates rows.
 * - Enter / Space activates the focused row.
 */

import {
  useEffect,
  useRef,
  useCallback,
  type KeyboardEvent,
} from "react";
import {
  File,
  Plug,
  Sparkles,
  Package,
} from "lucide-react";
import styles from "./AddMenu.module.css";

// ── Option definitions ─────────────────────────────────────────────────────

export type AddMenuKind = "files" | "connectors" | "skills" | "plugins";

interface MenuOption {
  kind: AddMenuKind;
  icon: typeof File;
  label: string;
  description: string;
}

const OPTIONS: MenuOption[] = [
  {
    kind: "files",
    icon: File,
    label: "Files",
    description: "Attach files from your computer",
  },
  {
    kind: "connectors",
    icon: Plug,
    label: "Connectors",
    description: "Connect external services via MCP",
  },
  {
    kind: "skills",
    icon: Sparkles,
    label: "Skills",
    description: "Enable or browse Kozum skills",
  },
  {
    kind: "plugins",
    icon: Package,
    label: "Plugins",
    description: "Manage installed plugins",
  },
];

// ── Props ──────────────────────────────────────────────────────────────────

export interface AddMenuProps {
  /** Called when the user picks an option. Parent decides what each does. */
  onPick: (kind: AddMenuKind) => void;
  /** Called when the menu should close (Escape or click-outside). */
  onClose: () => void;
  /** Element to return focus to when the menu closes. */
  triggerRef?: React.RefObject<HTMLElement | null>;
}

// ── Component ──────────────────────────────────────────────────────────────

export function AddMenu({ onPick, onClose, triggerRef }: AddMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const firstItemRef = useRef<HTMLButtonElement | null>(null);

  // Focus the first item on open.
  useEffect(() => {
    firstItemRef.current?.focus();
  }, []);

  // Click-outside close.
  const handleMouseDown = useCallback(
    (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [handleMouseDown]);

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      triggerRef?.current?.focus();
      return;
    }

    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        "[data-menu-item]",
      ) ?? [],
    );
    const focused = document.activeElement as HTMLElement;
    const idx = items.indexOf(focused as HTMLButtonElement);

    if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(idx + 1) % items.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items[(idx - 1 + items.length) % items.length]?.focus();
    }
  }

  return (
    <div
      ref={menuRef}
      className={styles.menu}
      role="menu"
      aria-label="Add attachment"
      onKeyDown={handleKeyDown}
    >
      {OPTIONS.map((opt, i) => {
        const Icon = opt.icon;
        return (
          <button
            key={opt.kind}
            className={styles.row}
            role="menuitem"
            data-menu-item
            ref={i === 0 ? firstItemRef : undefined}
            onClick={() => {
              onPick(opt.kind);
              onClose();
            }}
          >
            <span className={styles.iconWrap} aria-hidden={true}>
              <Icon size={16} />
            </span>
            <span className={styles.text}>
              <span className={styles.label}>{opt.label}</span>
              <span className={styles.description}>{opt.description}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
