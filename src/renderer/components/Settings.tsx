/**
 * Kozum Cowork — settings modal.
 *
 * Left nav with searchable sections; scrolling right pane. Panes:
 * General, Privacy, Usage (stub), Providers, Cowork, Code, Skills,
 * Connectors, Plugins.
 */

import { useState, useMemo, type ReactNode } from "react";
import {
  X,
  Search,
  Settings as SettingsIcon,
  Shield,
  BarChart2,
  ListTodo,
  Code2,
  Zap,
  Plug,
  Puzzle,
  Key,
  Plus,
  Trash2,
  Eye,
  EyeOff,
  ToggleLeft,
  ToggleRight,
} from "lucide-react";
import type {
  AppSettings,
  ProviderPreset,
  ApiKeyEntry,
  Skill,
  McpServerConfig,
  Plugin,
  PermissionMode,
} from "@shared/types.ts";
import styles from "./Settings.module.css";

// ── Nav items ──────────────────────────────────────────────────────────────

type NavId =
  | "general"
  | "privacy"
  | "usage"
  | "providers"
  | "cowork"
  | "code"
  | "skills"
  | "connectors"
  | "plugins";

interface NavItem {
  id: NavId;
  label: string;
  icon: typeof SettingsIcon;
}

const NAV: NavItem[] = [
  { id: "general", label: "General", icon: SettingsIcon },
  { id: "privacy", label: "Privacy", icon: Shield },
  { id: "usage", label: "Usage", icon: BarChart2 },
  { id: "providers", label: "Providers", icon: Key },
  { id: "cowork", label: "Cowork", icon: ListTodo },
  { id: "code", label: "Code", icon: Code2 },
  { id: "skills", label: "Skills", icon: Zap },
  { id: "connectors", label: "Connectors", icon: Plug },
  { id: "plugins", label: "Plugins", icon: Puzzle },
];

// ── Small helpers ──────────────────────────────────────────────────────────

interface FieldProps {
  label: string;
  hint?: string;
  children: ReactNode;
}

function Field({ label, hint, children }: FieldProps) {
  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel}>{label}</label>
      {hint && <p className={styles.fieldHint}>{hint}</p>}
      <div className={styles.fieldControl}>{children}</div>
    </div>
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <select
      className={styles.select}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      className={styles.textInput}
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
    />
  );
}

function Textarea({
  value,
  onChange,
  placeholder,
  rows,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <textarea
      className={styles.textarea}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows ?? 4}
    />
  );
}

// ── Panes ──────────────────────────────────────────────────────────────────

function PaneGeneral({
  settings,
  onChange,
}: {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
}) {
  const g = settings.general;

  function patch(k: keyof AppSettings["general"], v: string) {
    onChange({ general: { ...g, [k]: v } });
  }

  return (
    <div className={styles.pane}>
      <h2 className={styles.paneTitle}>General</h2>

      <Field label="Your name">
        <TextInput
          value={g.userName}
          onChange={(v) => patch("userName", v)}
          placeholder="e.g. Alex"
        />
      </Field>

      <Field
        label="What you do"
        hint="Kozum tailors its behaviour to your role and context."
      >
        <TextInput
          value={g.workDescription}
          onChange={(v) => patch("workDescription", v)}
          placeholder="e.g. Senior engineer at a startup"
        />
      </Field>

      <Field
        label="Custom instructions"
        hint="Always prepended to every task prompt."
      >
        <Textarea
          value={g.customInstructions}
          onChange={(v) => patch("customInstructions", v)}
          placeholder="Always reply in English…"
          rows={5}
        />
      </Field>

      <Field label="Appearance">
        <Select
          value={g.appearance}
          onChange={(v) => patch("appearance", v)}
          options={[
            { value: "system", label: "System" },
            { value: "dark", label: "Dark" },
            { value: "light", label: "Light" },
          ]}
        />
      </Field>

      <Field label="Chat font">
        <Select
          value={g.chatFont}
          onChange={(v) => patch("chatFont", v)}
          options={[
            { value: "sans", label: "Sans-serif" },
            { value: "serif", label: "Serif" },
            { value: "mono", label: "Monospace" },
          ]}
        />
      </Field>

      <Field label="Motion">
        <Select
          value={g.motion}
          onChange={(v) => patch("motion", v)}
          options={[
            { value: "system", label: "System" },
            { value: "reduced", label: "Reduced" },
          ]}
        />
      </Field>

      <Field label="Language">
        <Select
          value={g.language}
          onChange={(v) => patch("language", v)}
          options={[
            { value: "en", label: "English" },
            { value: "ar", label: "Arabic (عربى)" },
          ]}
        />
      </Field>
    </div>
  );
}

function PanePrivacy({ settings }: { settings: AppSettings }) {
  return (
    <div className={styles.pane}>
      <h2 className={styles.paneTitle}>Privacy</h2>
      <div className={styles.card}>
        <div className={styles.cardRow}>
          <div>
            <p className={styles.cardLabel}>Telemetry</p>
            <p className={styles.cardDesc}>
              Kozum never collects usage data.
            </p>
          </div>
          <span className={styles.badge}>
            {settings.privacy.telemetry ? "On" : "Off"}
          </span>
        </div>
      </div>
    </div>
  );
}

function PaneUsage() {
  return (
    <div className={styles.pane}>
      <h2 className={styles.paneTitle}>Usage</h2>
      <p className={styles.emptyNote}>
        Token usage statistics will appear here after your first session.
      </p>
    </div>
  );
}

function PaneProviders({
  presets,
  keys,
  onAddKey,
  onRemoveKey,
}: {
  presets: ProviderPreset[];
  keys: Record<string, ApiKeyEntry[]>;
  onAddKey: (providerId: string, label: string, raw: string) => void;
  onRemoveKey: (keyId: string) => void;
}) {
  const [addingFor, setAddingFor] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const [newKey, setNewKey] = useState("");
  const [showKey, setShowKey] = useState(false);

  function submitAdd() {
    if (!addingFor || !newLabel || !newKey) return;
    onAddKey(addingFor, newLabel, newKey);
    setAddingFor(null);
    setNewLabel("");
    setNewKey("");
    setShowKey(false);
  }

  return (
    <div className={styles.pane}>
      <h2 className={styles.paneTitle}>Providers</h2>
      {presets.map((p) => (
        <div key={p.id} className={styles.providerSection}>
          <div className={styles.providerHeader}>
            <span className={styles.providerName}>{p.name}</span>
            {p.docsUrl && (
              <a
                href={p.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.docsLink}
              >
                Docs
              </a>
            )}
            <button
              className={styles.addKeyBtn}
              onClick={() => {
                setAddingFor(p.id);
                setNewLabel("");
                setNewKey("");
              }}
            >
              <Plus size={13} />
              <span>Add key</span>
            </button>
          </div>

          {p.notes && (
            <p className={styles.providerNotes}>{p.notes}</p>
          )}

          {addingFor === p.id && (
            <div className={styles.addKeyForm}>
              <TextInput
                value={newLabel}
                onChange={setNewLabel}
                placeholder="Label (e.g. Personal)"
              />
              <div className={styles.keyFieldRow}>
                <input
                  className={styles.textInput}
                  type={showKey ? "text" : "password"}
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  placeholder="sk-..."
                  autoComplete="off"
                />
                <button
                  className={styles.showToggle}
                  onClick={() => setShowKey((v) => !v)}
                  aria-label={showKey ? "Hide key" : "Show key"}
                >
                  {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
              <div className={styles.addKeyActions}>
                <button className={styles.cancelBtn} onClick={() => setAddingFor(null)}>
                  Cancel
                </button>
                <button
                  className={styles.saveBtn}
                  onClick={submitAdd}
                  disabled={!newLabel || !newKey}
                >
                  Save
                </button>
              </div>
            </div>
          )}

          <ul className={styles.keyList}>
            {(keys[p.id] ?? []).map((k) => (
              <li key={k.id} className={styles.keyItem}>
                <div className={styles.keyDetails}>
                  <span className={styles.keyLabel}>{k.label}</span>
                  <span className={styles.keyMasked}>{k.maskedKey}</span>
                </div>
                <span
                  className={`${styles.keyStatus} ${
                    k.status === "valid"
                      ? styles.keyStatusOk
                      : k.status === "invalid" || k.status === "error"
                        ? styles.keyStatusErr
                        : styles.keyStatusUnknown
                  }`}
                >
                  {k.status}
                </span>
                <button
                  className={styles.removeBtn}
                  onClick={() => onRemoveKey(k.id)}
                  aria-label="Remove key"
                >
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function PaneMode({
  label,
  modeSettings,
  onChange,
}: {
  label: string;
  modeSettings: AppSettings["cowork"];
  onChange: (patch: Partial<AppSettings["cowork"]>) => void;
}) {
  return (
    <div className={styles.pane}>
      <h2 className={styles.paneTitle}>{label}</h2>

      <Field label="Max output tokens">
        <input
          className={styles.textInput}
          type="number"
          min={256}
          max={65536}
          step={256}
          value={modeSettings.maxTokens}
          onChange={(e) => onChange({ maxTokens: Number(e.target.value) })}
        />
      </Field>

      <Field label="Temperature" hint="0 = deterministic, 1 = creative.">
        <input
          className={styles.textInput}
          type="number"
          min={0}
          max={2}
          step={0.05}
          value={modeSettings.temperature}
          onChange={(e) => onChange({ temperature: Number(e.target.value) })}
        />
      </Field>

      <Field label="Max iterations" hint="Hard ceiling on tool-call rounds per user turn.">
        <input
          className={styles.textInput}
          type="number"
          min={1}
          max={500}
          step={1}
          value={modeSettings.maxIterations}
          onChange={(e) => onChange({ maxIterations: Number(e.target.value) })}
        />
      </Field>

      <Field label="Permission mode">
        <Select
          value={modeSettings.permissionMode}
          onChange={(v) => onChange({ permissionMode: v as PermissionMode })}
          options={[
            { value: "manual", label: "Manual — confirm every action" },
            { value: "accept_edits", label: "Accept edits — confirm shell only" },
            { value: "plan", label: "Plan — read-only, no execution" },
            { value: "bypass_permissions", label: "Bypass — no confirmations" },
          ]}
        />
      </Field>
    </div>
  );
}

function PaneToggleList({
  title,
  items,
  onToggle,
  onAdd,
}: {
  title: string;
  items: Array<{ id: string; name: string; description: string; enabled: boolean }>;
  onToggle: (id: string, enabled: boolean) => void;
  onAdd: () => void;
}) {
  return (
    <div className={styles.pane}>
      <div className={styles.paneHeaderRow}>
        <h2 className={styles.paneTitle}>{title}</h2>
        <button className={styles.addBtn} onClick={onAdd}>
          <Plus size={13} />
          <span>Add</span>
        </button>
      </div>

      {items.length === 0 ? (
        <p className={styles.emptyNote}>No {title.toLowerCase()} installed.</p>
      ) : (
        <ul className={styles.toggleList}>
          {items.map((item) => (
            <li key={item.id} className={styles.toggleItem}>
              <div className={styles.toggleInfo}>
                <span className={styles.toggleName}>{item.name}</span>
                <span className={styles.toggleDesc}>{item.description}</span>
              </div>
              <button
                className={styles.toggleBtn}
                onClick={() => onToggle(item.id, !item.enabled)}
                aria-label={item.enabled ? "Disable" : "Enable"}
                aria-pressed={item.enabled}
              >
                {item.enabled ? (
                  <ToggleRight size={22} className={styles.toggleOn} />
                ) : (
                  <ToggleLeft size={22} className={styles.toggleOff} />
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Main modal ─────────────────────────────────────────────────────────────

interface Props {
  settings: AppSettings;
  presets: ProviderPreset[];
  keys: Record<string, ApiKeyEntry[]>;
  skills: Skill[];
  connectors: McpServerConfig[];
  plugins: Plugin[];
  onSave: (patch: Partial<AppSettings>) => void;
  onAddKey: (providerId: string, label: string, raw: string) => void;
  onRemoveKey: (keyId: string) => void;
  onToggleSkill: (id: string, enabled: boolean) => void;
  onToggleConnector: (id: string, enabled: boolean) => void;
  onTogglePlugin: (id: string, enabled: boolean) => void;
  onAddSkill: () => void;
  onAddConnector: () => void;
  onAddPlugin: () => void;
  onClose: () => void;
}

export function Settings({
  settings,
  presets,
  keys,
  skills,
  connectors,
  plugins,
  onSave,
  onAddKey,
  onRemoveKey,
  onToggleSkill,
  onToggleConnector,
  onTogglePlugin,
  onAddSkill,
  onAddConnector,
  onAddPlugin,
  onClose,
}: Props) {
  const [activeNav, setActiveNav] = useState<NavId>("general");
  const [navSearch, setNavSearch] = useState("");

  const filteredNav = useMemo(
    () =>
      NAV.filter((n) =>
        n.label.toLowerCase().includes(navSearch.toLowerCase()),
      ),
    [navSearch],
  );

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Settings">
      <div className={styles.modal}>
        {/* Left nav */}
        <div className={styles.nav}>
          <div className={styles.navSearch}>
            <Search size={13} className={styles.navSearchIcon} />
            <input
              className={styles.navSearchInput}
              placeholder="Search settings"
              value={navSearch}
              onChange={(e) => setNavSearch(e.target.value)}
              aria-label="Search settings"
            />
          </div>
          <ul className={styles.navList}>
            {filteredNav.map((item) => (
              <li key={item.id}>
                <button
                  className={`${styles.navItem} ${activeNav === item.id ? styles.navActive : ""}`}
                  onClick={() => setActiveNav(item.id)}
                  aria-current={activeNav === item.id ? "page" : undefined}
                >
                  <item.icon size={14} className={styles.navIcon} />
                  <span>{item.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        {/* Right pane */}
        <div className={styles.content}>
          <div className={styles.contentScroll}>
            {activeNav === "general" && (
              <PaneGeneral settings={settings} onChange={onSave} />
            )}
            {activeNav === "privacy" && <PanePrivacy settings={settings} />}
            {activeNav === "usage" && <PaneUsage />}
            {activeNav === "providers" && (
              <PaneProviders
                presets={presets}
                keys={keys}
                onAddKey={onAddKey}
                onRemoveKey={onRemoveKey}
              />
            )}
            {activeNav === "cowork" && (
              <PaneMode
                label="Cowork"
                modeSettings={settings.cowork}
                onChange={(p) => onSave({ cowork: { ...settings.cowork, ...p } })}
              />
            )}
            {activeNav === "code" && (
              <PaneMode
                label="Code"
                modeSettings={settings.code}
                onChange={(p) => onSave({ code: { ...settings.code, ...p } })}
              />
            )}
            {activeNav === "skills" && (
              <PaneToggleList
                title="Skills"
                items={skills.map((s) => ({
                  id: s.id,
                  name: s.name,
                  description: s.description,
                  enabled: s.enabled,
                }))}
                onToggle={onToggleSkill}
                onAdd={onAddSkill}
              />
            )}
            {activeNav === "connectors" && (
              <PaneToggleList
                title="Connectors"
                items={connectors.map((c) => ({
                  id: c.id,
                  name: c.name,
                  description: `${c.transport} · ${c.toolCount} tools`,
                  enabled: c.enabled,
                }))}
                onToggle={onToggleConnector}
                onAdd={onAddConnector}
              />
            )}
            {activeNav === "plugins" && (
              <PaneToggleList
                title="Plugins"
                items={plugins.map((p) => ({
                  id: p.id,
                  name: p.name,
                  description: p.description,
                  enabled: p.enabled,
                }))}
                onToggle={onTogglePlugin}
                onAdd={onAddPlugin}
              />
            )}
          </div>
        </div>

        {/* Close */}
        <button className={styles.closeBtn} onClick={onClose} aria-label="Close settings">
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
