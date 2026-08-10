/**
 * Kozum Cowork — CustomProviderDialog.
 *
 * Modal for adding a new custom OpenAI-compatible provider.
 * Collects name + base URL, then calls onSave which calls providers.addCustom.
 */

import { useState, useEffect, useRef } from "react";
import { X } from "lucide-react";
import styles from "./CustomProviderDialog.module.css";

// ── Props ──────────────────────────────────────────────────────────────────

export interface CustomProviderDialogProps {
  onSave: (name: string, baseUrl: string) => Promise<void>;
  onClose: () => void;
}

// ── Component ──────────────────────────────────────────────────────────────

export function CustomProviderDialog({ onSave, onClose }: CustomProviderDialogProps) {
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  // Focus name on mount
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  async function handleSave() {
    const n = name.trim();
    const u = baseUrl.trim();
    if (!n || !u) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(n, u);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add provider.");
      setSaving(false);
    }
  }

  function handleOverlayClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose();
  }

  const valid = name.trim().length > 0 && baseUrl.trim().length > 0;

  return (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-label="Add custom provider"
      onClick={handleOverlayClick}
    >
      <div className={styles.dialog}>
        <div className={styles.header}>
          <span className={styles.title}>Add custom provider</span>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">
            <X size={15} />
          </button>
        </div>

        <div className={styles.body}>
          <p className={styles.hint}>
            Any OpenAI-compatible endpoint. Keys can be added after saving.
          </p>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="cpd-name">
              Provider name
            </label>
            <input
              ref={nameRef}
              id="cpd-name"
              className={styles.input}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. LM Studio"
              autoComplete="off"
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="cpd-url">
              Base URL
            </label>
            <input
              id="cpd-url"
              className={styles.input}
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="http://localhost:1234/v1"
              autoComplete="off"
              onKeyDown={(e) => {
                if (e.key === "Enter" && valid && !saving) handleSave();
              }}
            />
          </div>

          {error && <p className={styles.error}>{error}</p>}
        </div>

        <div className={styles.footer}>
          <button className={styles.cancelBtn} onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            className={styles.saveBtn}
            onClick={handleSave}
            disabled={!valid || saving}
          >
            {saving ? "Saving…" : "Add provider"}
          </button>
        </div>
      </div>
    </div>
  );
}
