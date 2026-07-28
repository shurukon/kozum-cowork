/**
 * Kozum Cowork — cascading model picker.
 *
 * Three-stage picker: Provider → API key (only when provider has >1 key) →
 * Model. Includes a search filter and "Refresh models" action.
 * Shows a vision badge on capable models; warns when vision is "no" and
 * computer use is enabled.
 */

import { useEffect, useState, useCallback } from "react";
import {
  ChevronRight,
  Search,
  RefreshCw,
  Eye,
  EyeOff,
  Check,
  AlertTriangle,
} from "lucide-react";
import type { ProviderPreset, ApiKeyEntry, ModelInfo } from "@shared/types.ts";
import styles from "./ModelPicker.module.css";

// ── Stage type ─────────────────────────────────────────────────────────────

type Stage = "provider" | "key" | "model";

interface Selection {
  providerId: string;
  keyId: string | null;
  modelId: string;
}

interface Props {
  presets: ProviderPreset[];
  keys: Record<string, ApiKeyEntry[]>;
  models: Record<string, ModelInfo[]>;
  value: Selection;
  onChange: (s: Selection) => void;
  onRefreshModels: (providerId: string) => Promise<void>;
  computerUseEnabled: boolean;
  onClose: () => void;
}

export function ModelPicker({
  presets,
  keys,
  models,
  value,
  onChange,
  onRefreshModels,
  computerUseEnabled,
  onClose,
}: Props) {
  const [stage, setStage] = useState<Stage>("provider");
  const [selectedProvider, setSelectedProvider] = useState<ProviderPreset | null>(
    presets.find((p) => p.id === value.providerId) ?? null,
  );
  const [selectedKey, setSelectedKey] = useState<ApiKeyEntry | null>(null);
  const [search, setSearch] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  // When provider changes, reset downstream stages.
  const pickProvider = useCallback(
    (preset: ProviderPreset) => {
      setSelectedProvider(preset);
      const providerKeys = keys[preset.id] ?? [];
      if (providerKeys.length > 1) {
        setStage("key");
      } else {
        setSelectedKey(providerKeys[0] ?? null);
        setStage("model");
      }
      setSearch("");
    },
    [keys],
  );

  const pickKey = useCallback(
    (key: ApiKeyEntry) => {
      setSelectedKey(key);
      setStage("model");
      setSearch("");
    },
    [],
  );

  const pickModel = useCallback(
    (model: ModelInfo) => {
      if (!selectedProvider) return;
      onChange({
        providerId: selectedProvider.id,
        keyId: selectedKey?.id ?? null,
        modelId: model.id,
      });
      onClose();
    },
    [selectedProvider, selectedKey, onChange, onClose],
  );

  async function handleRefresh() {
    if (!selectedProvider || refreshing) return;
    setRefreshing(true);
    try {
      await onRefreshModels(selectedProvider.id);
    } finally {
      setRefreshing(false);
    }
  }

  // Sync selected provider when value changes externally.
  useEffect(() => {
    if (value.providerId) {
      const p = presets.find((x) => x.id === value.providerId);
      if (p) setSelectedProvider(p);
    }
  }, [value.providerId, presets]);

  // Filter lists by search.
  const filteredProviders = presets.filter((p) =>
    p.name.toLowerCase().includes(search.toLowerCase()),
  );

  const filteredKeys = (selectedProvider ? (keys[selectedProvider.id] ?? []) : []).filter((k) =>
    k.label.toLowerCase().includes(search.toLowerCase()),
  );

  const filteredModels = (selectedProvider ? (models[selectedProvider.id] ?? []) : []).filter((m) =>
    m.displayName.toLowerCase().includes(search.toLowerCase()) ||
    m.id.toLowerCase().includes(search.toLowerCase()),
  );

  // Current selected model info (for warning banner).
  const currentModel = selectedProvider
    ? (models[selectedProvider.id] ?? []).find((m) => m.id === value.modelId)
    : null;

  const showVisionWarning =
    computerUseEnabled &&
    currentModel?.capabilities.vision === "no" &&
    stage === "model";

  return (
    <div className={styles.picker}>
      {/* Search */}
      <div className={styles.searchRow}>
        <Search size={14} className={styles.searchIcon} />
        <input
          className={styles.search}
          placeholder={
            stage === "provider" ? "Search providers…" : stage === "key" ? "Search keys…" : "Search models…"
          }
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
          aria-label="Search"
        />
        {stage !== "provider" && (
          <button
            className={styles.backBtn}
            onClick={() => {
              setStage(stage === "model" && selectedProvider && (keys[selectedProvider.id]?.length ?? 0) > 1 ? "key" : "provider");
              setSearch("");
            }}
          >
            ← Back
          </button>
        )}
      </div>

      {/* Vision warning */}
      {showVisionWarning && (
        <div className={styles.warning}>
          <AlertTriangle size={13} />
          <span>
            Computer use requires vision. This model does not support it.
          </span>
        </div>
      )}

      {/* Breadcrumb */}
      <div className={styles.breadcrumb}>
        <span
          className={`${styles.crumb} ${stage === "provider" ? styles.crumbActive : ""}`}
          onClick={() => { setStage("provider"); setSearch(""); }}
        >
          {selectedProvider?.name ?? "Provider"}
        </span>
        {stage !== "provider" && (
          <>
            <ChevronRight size={12} className={styles.crumbSep} />
            <span
              className={`${styles.crumb} ${stage === "key" ? styles.crumbActive : ""}`}
              onClick={() => {
                if (selectedProvider && (keys[selectedProvider.id]?.length ?? 0) > 1) {
                  setStage("key");
                  setSearch("");
                }
              }}
            >
              {selectedKey?.label ?? "Key"}
            </span>
          </>
        )}
        {stage === "model" && (
          <>
            <ChevronRight size={12} className={styles.crumbSep} />
            <span className={`${styles.crumb} ${styles.crumbActive}`}>Model</span>
          </>
        )}
      </div>

      <div className={styles.list}>
        {/* Stage: provider */}
        {stage === "provider" &&
          filteredProviders.map((p) => (
            <button
              key={p.id}
              className={`${styles.row} ${p.id === value.providerId ? styles.rowSelected : ""}`}
              onClick={() => pickProvider(p)}
            >
              <span className={styles.rowLabel}>{p.name}</span>
              {p.id === value.providerId && <Check size={13} className={styles.check} />}
              <ChevronRight size={13} className={styles.rowArrow} />
            </button>
          ))}

        {/* Stage: key */}
        {stage === "key" &&
          filteredKeys.map((k) => (
            <button
              key={k.id}
              className={`${styles.row} ${k.id === value.keyId ? styles.rowSelected : ""}`}
              onClick={() => pickKey(k)}
            >
              <div className={styles.keyInfo}>
                <span className={styles.rowLabel}>{k.label}</span>
                <span className={styles.keyMasked}>{k.maskedKey}</span>
              </div>
              {k.id === value.keyId && <Check size={13} className={styles.check} />}
              <ChevronRight size={13} className={styles.rowArrow} />
            </button>
          ))}

        {/* Stage: model */}
        {stage === "model" && (
          <>
            <button
              className={styles.refreshBtn}
              onClick={() => void handleRefresh()}
              disabled={refreshing}
            >
              <RefreshCw
                size={13}
                className={refreshing ? "kz-spin" : undefined}
              />
              <span>{refreshing ? "Refreshing…" : "Refresh models"}</span>
            </button>

            {filteredModels.map((m) => (
              <button
                key={m.id}
                className={`${styles.row} ${m.id === value.modelId ? styles.rowSelected : ""}`}
                onClick={() => pickModel(m)}
              >
                <div className={styles.modelInfo}>
                  <span className={styles.rowLabel}>{m.displayName}</span>
                  {m.description && (
                    <span className={styles.modelDesc}>{m.description}</span>
                  )}
                </div>
                <div className={styles.badges}>
                  {m.capabilities.vision === "yes" && (
                    <span className={styles.visionBadge} title="Vision capable">
                      <Eye size={11} />
                    </span>
                  )}
                  {m.capabilities.vision === "no" && computerUseEnabled && (
                    <span
                      className={`${styles.visionBadge} ${styles.visionNo}`}
                      title="No vision support"
                    >
                      <EyeOff size={11} />
                    </span>
                  )}
                </div>
                {m.id === value.modelId && <Check size={13} className={styles.check} />}
              </button>
            ))}

            {filteredModels.length === 0 && (
              <p className={styles.noResults}>
                No models found. Try refreshing.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
