/**
 * Kozum Cowork — SelectorBar: Provider / API Key / Model inline dropdowns.
 *
 * Three self-contained popover dropdowns rendered inline in the composer.
 * Controlled: parent owns ModelSelection state and calls onChange.
 * Does NOT open Settings — all switching is done inline.
 *
 * Provider dropdown: lists all ProviderPreset entries.
 * Key dropdown: only shown when the chosen provider has >1 key.
 * Model dropdown: all cached ModelInfo for the chosen provider, with Refresh
 *   affordance and a filter input for long lists. Vision-capable models get a
 *   small "vision" badge.
 */

import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type KeyboardEvent,
  type ChangeEvent,
} from "react";
import {
  ChevronDown,
  RefreshCw,
  Eye,
  Check,
  Key,
  Cpu,
  Server,
} from "lucide-react";
import type {
  ModelSelection,
  ProviderPreset,
  ApiKeyEntry,
  ModelInfo,
} from "@shared/types.ts";
import styles from "./SelectorBar.module.css";

// ── Shared popover logic ───────────────────────────────────────────────────

interface PopoverAnchorProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  anchorRef: React.RefObject<HTMLElement | null>;
}

function Popover({ isOpen, onClose, children, anchorRef }: PopoverAnchorProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = useCallback(
    (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        panelRef.current &&
        !panelRef.current.contains(target) &&
        anchorRef.current &&
        !anchorRef.current.contains(target)
      ) {
        onClose();
      }
    },
    [onClose, anchorRef],
  );

  useEffect(() => {
    if (!isOpen) return;
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [isOpen, handleMouseDown]);

  if (!isOpen) return null;

  return (
    <div ref={panelRef} className={styles.popover}>
      {children}
    </div>
  );
}

// ── Props ──────────────────────────────────────────────────────────────────

export interface SelectorBarProps {
  selection: ModelSelection;
  presets: ProviderPreset[];
  keysByProvider: Record<string, ApiKeyEntry[]>;
  modelsByProvider: Record<string, ModelInfo[]>;
  onChange: (next: ModelSelection) => void;
  onRefreshModels: (providerId: string) => Promise<ModelInfo[] | void>;
}

// ── Provider dropdown ──────────────────────────────────────────────────────

interface ProviderDropdownProps {
  selection: ModelSelection;
  presets: ProviderPreset[];
  keysByProvider: Record<string, ApiKeyEntry[]>;
  modelsByProvider: Record<string, ModelInfo[]>;
  onChange: (next: ModelSelection) => void;
}

function ProviderDropdown({
  selection,
  presets,
  keysByProvider,
  modelsByProvider,
  onChange,
}: ProviderDropdownProps) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  const current = presets.find((p) => p.id === selection.providerId);

  function pick(preset: ProviderPreset) {
    const availableKeys = keysByProvider[preset.id] ?? [];
    const defaultKeyId = availableKeys[0]?.id ?? null;
    const availableModels = modelsByProvider[preset.id] ?? [];
    const defaultModelId = availableModels.some((m) => m.id === selection.modelId)
      ? selection.modelId
      : availableModels[0]?.id ?? preset.staticModels?.[0] ?? selection.modelId;
    onChange({ providerId: preset.id, keyId: defaultKeyId, modelId: defaultModelId });
    setOpen(false);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      setOpen(false);
      btnRef.current?.focus();
    }
  }

  return (
    <div className={styles.selectorWrap} onKeyDown={handleKeyDown}>
      <button
        ref={btnRef}
        className={styles.selectorBtn}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Provider: ${current?.name ?? selection.providerId}`}
      >
        <Server size={13} aria-hidden={true} />
        <span className={styles.selectorLabel}>
          {current?.name ?? selection.providerId}
        </span>
        <ChevronDown size={12} className={styles.chevron} aria-hidden={true} />
      </button>

      <Popover isOpen={open} onClose={() => setOpen(false)} anchorRef={btnRef}>
        <div className={styles.popoverInner} role="listbox" aria-label="Choose provider">
          <p className={styles.popoverHeading}>Provider</p>
          <div className={styles.optionList}>
            {presets.map((p) => (
            <button
              key={p.id}
              className={`${styles.option} ${p.id === selection.providerId ? styles.optionActive : ""}`}
              role="option"
              aria-selected={p.id === selection.providerId}
              onClick={() => pick(p)}
            >
              <span className={styles.optionLabel}>{p.name}</span>
              {!p.builtIn && (
                <span className={styles.badge}>custom</span>
              )}
              {p.id === selection.providerId && (
                <Check size={13} className={styles.optionCheck} aria-hidden={true} />
              )}
            </button>
            ))}
          </div>
          <p className={styles.emptyMsg}>
            Your own server? Settings → AI providers → “Add provider” (name + Base URL + key + model).
          </p>
        </div>
      </Popover>
    </div>
  );
}

// ── Key dropdown ───────────────────────────────────────────────────────────

interface KeyDropdownProps {
  selection: ModelSelection;
  keys: ApiKeyEntry[];
  onChange: (next: ModelSelection) => void;
}

function KeyDropdown({ selection, keys, onChange }: KeyDropdownProps) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  // The key indicator is intentionally always visible. A single saved key is
  // still important state in the chat; only the popover itself is conditional.
  const current = keys.find((k) => k.id === selection.keyId) ?? keys[0];
  const canChoose = keys.length > 1;
  const keyStatus = current?.status ?? "missing";
  const keyStatusClass =
    keyStatus === "valid"
      ? styles.keyStatusValid
      : keyStatus === "invalid"
        ? styles.keyStatusInvalid
        : keyStatus === "error"
          ? styles.keyStatusError
          : styles.keyStatusMissing;

  function pick(k: ApiKeyEntry) {
    onChange({ ...selection, keyId: k.id });
    setOpen(false);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      setOpen(false);
      btnRef.current?.focus();
    }
  }

  return (
    <div className={styles.selectorWrap} onKeyDown={handleKeyDown}>
      <button
        ref={btnRef}
        className={styles.selectorBtn}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup={canChoose ? "listbox" : undefined}
        aria-expanded={canChoose ? open : undefined}
        aria-label={`API key: ${current?.maskedKey ?? "none"}`}
        disabled={!canChoose}
        title={current ? `${current.label} — ${current.status}` : "No API key saved"}
      >
        <Key size={13} aria-hidden={true} />
        <span className={styles.selectorLabel}>
          {current?.maskedKey ?? "No key"}
        </span>
        <span
          className={`${styles.keyStatus} ${keyStatusClass}`}
          aria-label={`API key status: ${keyStatus}`}
          title={`API key status: ${keyStatus}`}
        />
        {canChoose && <ChevronDown size={12} className={styles.chevron} aria-hidden={true} />}
      </button>

      <Popover isOpen={canChoose && open} onClose={() => setOpen(false)} anchorRef={btnRef}>
        <div className={styles.popoverInner} role="listbox" aria-label="Choose API key">
          <p className={styles.popoverHeading}>API Key</p>
          <div className={styles.optionList}>
            {keys.map((k) => (
            <button
              key={k.id}
              className={`${styles.option} ${k.id === selection.keyId ? styles.optionActive : ""}`}
              role="option"
              aria-selected={k.id === selection.keyId}
              onClick={() => pick(k)}
            >
              <span className={styles.optionLabel}>{k.label}</span>
              <span className={styles.masked}>{k.maskedKey}</span>
              {k.id === selection.keyId && (
                <Check size={13} className={styles.optionCheck} aria-hidden={true} />
              )}
            </button>
            ))}
          </div>
        </div>
      </Popover>
    </div>
  );
}

// ── Model dropdown ─────────────────────────────────────────────────────────

interface ModelDropdownProps {
  selection: ModelSelection;
  models: ModelInfo[];
  onRefreshModels: (providerId: string) => Promise<ModelInfo[] | void>;
  onChange: (next: ModelSelection) => void;
}

function ModelDropdown({ selection, models, onRefreshModels, onChange }: ModelDropdownProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [localModels, setLocalModels] = useState<ModelInfo[]>([]);

  const effectiveModels = models.length > 0 ? models : localModels;
  const btnRef = useRef<HTMLButtonElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  const current = effectiveModels.find((m) => m.id === selection.modelId);
  const currentLabel = current?.displayName ?? selection.modelId;

  // Focus filter on open.
  useEffect(() => {
    if (open) {
      setTimeout(() => filterRef.current?.focus(), 0);
    } else {
      setFilter("");
    }
  }, [open]);

  useEffect(() => {
    setLocalModels([]);
  }, [selection.providerId]);

  const visible = filter
    ? effectiveModels.filter(
        (m) =>
          m.id.toLowerCase().includes(filter.toLowerCase()) ||
          m.displayName.toLowerCase().includes(filter.toLowerCase()),
      )
    : effectiveModels;

  function pick(m: ModelInfo) {
    onChange({ ...selection, modelId: m.id });
    setOpen(false);
  }

  async function refresh() {
    setRefreshing(true);
    try {
      const fetched = await onRefreshModels(selection.providerId);
      if (Array.isArray(fetched)) setLocalModels(fetched);
    } finally {
      setRefreshing(false);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      setOpen(false);
      btnRef.current?.focus();
    }
  }

  return (
    <div className={styles.selectorWrap} onKeyDown={handleKeyDown}>
      <button
        ref={btnRef}
        className={styles.selectorBtn}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Model: ${currentLabel}`}
      >
        <Cpu size={13} aria-hidden={true} />
        <span className={styles.selectorLabel}>{currentLabel}</span>
        <ChevronDown size={12} className={styles.chevron} aria-hidden={true} />
      </button>

      <Popover isOpen={open} onClose={() => setOpen(false)} anchorRef={btnRef}>
        <div className={styles.popoverInner} role="listbox" aria-label="Choose model">
          <div className={styles.popoverTopBar}>
            <p className={styles.popoverHeading}>Model</p>
            <button
              className={`${styles.refreshBtn} ${refreshing ? styles.refreshing : ""}`}
              onClick={refresh}
              disabled={refreshing}
              aria-label="Refresh models"
              title="Refresh models from provider"
            >
              <RefreshCw size={13} />
            </button>
          </div>

          {effectiveModels.length > 8 && (
            <div className={styles.filterWrap}>
              <input
                ref={filterRef}
                type="text"
                className={styles.filterInput}
                placeholder="Filter models…"
                value={filter}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setFilter(e.target.value)}
                aria-label="Filter models"
              />
            </div>
          )}

          <div className={styles.modelList}>
            {visible.length === 0 && (
              <p className={styles.emptyMsg}>No models match</p>
            )}
            {visible.map((m) => (
              <button
                key={m.id}
                className={`${styles.option} ${m.id === selection.modelId ? styles.optionActive : ""}`}
                role="option"
                aria-selected={m.id === selection.modelId}
                onClick={() => pick(m)}
              >
                <span className={styles.optionLabel}>{m.displayName}</span>
                <span className={styles.optionMeta}>
                  {m.capabilities.vision === "yes" && (
                    <span className={styles.visionBadge} title="Vision capable">
                      <Eye size={11} aria-hidden={true} />
                    </span>
                  )}
                </span>
                {m.id === selection.modelId && (
                  <Check size={13} className={styles.optionCheck} aria-hidden={true} />
                )}
              </button>
            ))}
          </div>
        </div>
      </Popover>
    </div>
  );
}

// ── SelectorBar ────────────────────────────────────────────────────────────

export function SelectorBar({
  selection,
  presets,
  keysByProvider,
  modelsByProvider,
  onChange,
  onRefreshModels,
}: SelectorBarProps) {
  const providerKeys = keysByProvider[selection.providerId] ?? [];
  const providerModels = modelsByProvider[selection.providerId] ?? [];

  // Auto-sync keyId when missing but keys exist for the chosen provider
  useEffect(() => {
    if (selection.providerId && !selection.keyId && providerKeys.length > 0) {
      onChange({ ...selection, keyId: providerKeys[0].id });
    }
  }, [selection, providerKeys, onChange]);

  return (
    <div className={styles.bar}>
      <ProviderDropdown
        selection={selection}
        presets={presets}
        keysByProvider={keysByProvider}
        modelsByProvider={modelsByProvider}
        onChange={onChange}
      />
      <KeyDropdown
        selection={selection}
        keys={providerKeys}
        onChange={onChange}
      />
      <ModelDropdown
        selection={selection}
        models={providerModels}
        onRefreshModels={onRefreshModels}
        onChange={onChange}
      />
    </div>
  );
}
