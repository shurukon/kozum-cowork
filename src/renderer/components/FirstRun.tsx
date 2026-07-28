/**
 * First-run provider setup.
 *
 * Shown on the home screen until a provider, key and model are configured.
 * Model selection belongs here rather than buried in Settings: the app is
 * useless without it, so asking on the first screen is the honest ordering —
 * and "Skip for now" keeps it from being a wall.
 */

import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Check, Key, Loader2 } from "lucide-react";

import type { ModelInfo, ProviderPreset } from "@shared/types.ts";
import styles from "./FirstRun.module.css";

interface Props {
  presets: ProviderPreset[];
  onSubmit: (providerId: string, label: string, rawKey: string) => Promise<string | null>;
  onRefreshModels: (providerId: string) => Promise<ModelInfo[]>;
  onChooseModel: (providerId: string, modelId: string) => void;
  onSkip: () => void;
}

/** Providers whose free tier makes them the sensible first suggestion. */
const FREE_FIRST = new Set(["nvidia-nim", "google-ai-studio", "cerebras", "openrouter"]);

export function FirstRun({
  presets,
  onSubmit,
  onRefreshModels,
  onChooseModel,
  onSkip,
}: Props) {
  const [providerId, setProviderId] = useState("");
  const [rawKey, setRawKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [filter, setFilter] = useState("");

  // Free providers first — someone with no account can still get started.
  const ordered = useMemo(() => {
    return [...presets].sort((a, b) => {
      const af = FREE_FIRST.has(a.id) ? 0 : 1;
      const bf = FREE_FIRST.has(b.id) ? 0 : 1;
      return af - bf || a.name.localeCompare(b.name);
    });
  }, [presets]);

  const preset = presets.find((p) => p.id === providerId) ?? null;

  useEffect(() => {
    setModels(null);
    setError(null);
  }, [providerId]);

  async function connect() {
    if (!providerId || !rawKey.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const failure = await onSubmit(providerId, "Default", rawKey.trim());
      if (failure) {
        setError(failure);
        return;
      }
      setRawKey("");
      const list = await onRefreshModels(providerId);
      setModels(list);
      if (list.length === 0) {
        setError(
          "The key was saved, but the provider returned no models. Check the key, " +
            "or pick a model manually in Settings once you have one.",
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const shown = useMemo(() => {
    if (!models) return [];
    const q = filter.trim().toLowerCase();
    const list = q ? models.filter((m) => m.id.toLowerCase().includes(q)) : models;
    return list.slice(0, 200);
  }, [models, filter]);

  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        <h2 className={styles.title}>Connect a model to get started</h2>
        <p className={styles.sub}>
          Kozum runs on whichever provider you choose. Several have a free tier —
          those are listed first.
        </p>

        <label className={styles.label} htmlFor="fr-provider">
          Provider
        </label>
        <select
          id="fr-provider"
          className={styles.select}
          value={providerId}
          onChange={(e) => setProviderId(e.target.value)}
        >
          <option value="">Select a provider…</option>
          {ordered.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {FREE_FIRST.has(p.id) ? "  (free tier)" : ""}
            </option>
          ))}
        </select>

        {preset?.notes && <p className={styles.note}>{preset.notes}</p>}

        {providerId && (
          <>
            <label className={styles.label} htmlFor="fr-key">
              API key
            </label>
            <div className={styles.keyRow}>
              <Key size={15} className={styles.keyIcon} />
              <input
                id="fr-key"
                className={styles.input}
                type="password"
                value={rawKey}
                placeholder="Paste your key"
                onChange={(e) => setRawKey(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void connect();
                }}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                className={styles.connect}
                onClick={() => void connect()}
                disabled={busy || !rawKey.trim()}
              >
                {busy ? <Loader2 size={14} className="kz-spin" /> : "Connect"}
              </button>
            </div>
            <p className={styles.hint}>
              Stored encrypted with your OS keychain. It never leaves this machine
              except to the provider you chose.
            </p>
          </>
        )}

        {error && (
          <div className={styles.error} role="alert">
            <AlertCircle size={15} />
            <span>{error}</span>
          </div>
        )}

        {models && models.length > 0 && (
          <div className={styles.models}>
            <div className={styles.modelsHead}>
              <span className={styles.ok}>
                <Check size={14} /> {models.length} models available
              </span>
              <input
                className={styles.filter}
                placeholder="Filter…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
            <ul className={styles.modelList}>
              {shown.map((m) => (
                <li key={m.id}>
                  <button
                    className={styles.model}
                    onClick={() => onChooseModel(providerId, m.id)}
                  >
                    <span className="kz-truncate">{m.displayName || m.id}</span>
                    {m.capabilities.vision === "yes" && (
                      <span className={styles.badge}>vision</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <button className={styles.skip} onClick={onSkip}>
          Skip for now — set this up later in Settings
        </button>
      </div>
    </div>
  );
}
