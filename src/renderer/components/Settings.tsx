/**
 * Kozum Cowork — Settings modal (major rework).
 *
 * Left nav with searchable panes. Panes:
 *   General, Providers, Cowork, Code, Skills, Connectors, Plugins.
 * (Privacy/Usage stay removed.)
 *
 * Key changes vs. old version:
 * - initialPane prop: "Customize" opens directly on Skills.
 * - Providers pane: NO label field; Cloudflare gets Account ID field;
 *   multiple keys per provider; custom providers with addCustom/removeCustom;
 *   coloured dot + text status (accessibility).
 * - Cowork + Code panes: model summary, max tokens, temperature, max iterations,
 *   default working folder (onPickFolder), toggles per-mode.
 * - General pane: Rules textarea (memory.getRules / setRules, debounced on blur).
 * - onPickFolder(mode) callback for native folder picker.
 */

import { useState, useMemo, useCallback, type ReactNode } from "react";
import {
  X,
  Search,
  Settings as SettingsIcon,
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
  FolderOpen,
  Circle,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Info,
} from "lucide-react";
import type {
  AppSettings,
  ProviderPreset,
  ApiKeyEntry,
  Skill,
  McpServerConfig,
  Plugin,
  Mode,
} from "@shared/types.ts";
import { useTheme } from "../hooks/useTheme.ts";
import { CustomProviderDialog } from "./CustomProviderDialog.tsx";
import styles from "./Settings.module.css";

// ── Nav items ──────────────────────────────────────────────────────────────

type NavId =
  | "general"
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
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  id?: string;
}) {
  return (
    <select
      className={styles.select}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      id={id}
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
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  id?: string;
}) {
  return (
    <input
      className={styles.textInput}
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      id={id}
    />
  );
}

function Textarea({
  value,
  onChange,
  onBlur,
  placeholder,
  rows,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  rows?: number;
  id?: string;
}) {
  return (
    <textarea
      className={styles.textarea}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      placeholder={placeholder}
      rows={rows ?? 4}
      id={id}
    />
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      className={styles.toggleBtn}
      onClick={() => onChange(!checked)}
      aria-label={label}
      aria-pressed={checked}
    >
      {checked ? (
        <ToggleRight size={22} className={styles.toggleOn} />
      ) : (
        <ToggleLeft size={22} className={styles.toggleOff} />
      )}
    </button>
  );
}

// Key status: coloured dot + text label for accessibility.
function KeyStatusBadge({ status }: { status: ApiKeyEntry["status"] }) {
  let cls = styles.keyStatusUnknown;
  let Icon = Circle;
  let label = "Untested";

  if (status === "valid") {
    cls = styles.keyStatusOk;
    Icon = CheckCircle2;
    label = "Valid";
  } else if (status === "invalid") {
    cls = styles.keyStatusErr;
    Icon = XCircle;
    label = "Invalid";
  } else if (status === "error") {
    cls = styles.keyStatusWarn;
    Icon = AlertCircle;
    label = "Error";
  }

  return (
    <span className={`${styles.keyStatusBadge} ${cls}`} aria-label={`Key status: ${label}`}>
      <Icon size={11} aria-hidden />
      <span>{label}</span>
    </span>
  );
}

// ── PaneGeneral ────────────────────────────────────────────────────────────

function PaneGeneral({
  settings,
  rules,
  onRulesChange,
  onRulesBlur,
  onChange,
}: {
  settings: AppSettings;
  rules: string;
  onRulesChange: (v: string) => void;
  onRulesBlur: () => void;
  onChange: (patch: Partial<AppSettings>) => void;
}) {
  const g = settings.general;

  function patch(k: keyof AppSettings["general"], v: string) {
    onChange({ general: { ...g, [k]: v } });
  }

  function patchBool(k: keyof AppSettings["general"], v: boolean) {
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

      <Field label="What you do" hint="Kozum tailors its behaviour to your role and context.">
        <TextInput
          value={g.workDescription}
          onChange={(v) => patch("workDescription", v)}
          placeholder="e.g. Senior engineer at a startup"
        />
      </Field>

      <Field label="Custom instructions" hint="Always prepended to every task prompt.">
        <Textarea
          value={g.customInstructions}
          onChange={(v) => patch("customInstructions", v)}
          placeholder="Always reply in English…"
          rows={4}
        />
      </Field>

      <Field label="Appearance">
        <Select
          value={g.appearance}
          onChange={(v) => patch("appearance", v)}
          options={[
            { value: "system", label: "System" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
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

      <div className={styles.toggleRow}>
        <span className={styles.toggleRowLabel}>
          <span>Auto-open previews</span>
          <span className={styles.toggleRowHint}>
            Open the preview panel automatically after a file write, edit, or screenshot.
          </span>
        </span>
        <Toggle
          checked={g.autoOpenPreviews}
          onChange={(v) => patchBool("autoOpenPreviews", v)}
          label="Toggle auto-open previews"
        />
      </div>

      <div className={styles.toggleRow}>
        <span className={styles.toggleRowLabel}>
          <span>Live browser preview</span>
          <span className={styles.toggleRowHint}>
            Show the agent's internal browser live in the preview panel while it navigates, clicks, or types.
          </span>
        </span>
        <Toggle
          checked={g.autoOpenBrowserPreview}
          onChange={(v) => patchBool("autoOpenBrowserPreview", v)}
          label="Toggle live browser preview"
        />
      </div>

      <div className={styles.divider} />

      <h3 className={styles.sectionTitle}>Rules</h3>
      <Field
        label="Standing rules"
        hint="Short strict instructions Kozum follows automatically every session. Saved on blur."
      >
        <Textarea
          value={rules}
          onChange={onRulesChange}
          onBlur={onRulesBlur}
          placeholder="e.g. Never truncate code. Always add type annotations."
          rows={5}
        />
      </Field>
    </div>
  );
}

// ── PaneProviders ──────────────────────────────────────────────────────────

interface PaneProvidersProps {
  presets: ProviderPreset[];
  keys: Record<string, ApiKeyEntry[]>;
  onAddKey: (
    providerId: string,
    rawKey: string,
    meta?: Record<string, string>,
  ) => void;
  onRemoveKey: (keyId: string) => void;
  onAddCustomProvider: (name: string, baseUrl: string) => Promise<void>;
  onRemoveCustomProvider: (id: string) => void;
}

interface AddKeyFormState {
  providerId: string;
  rawKey: string;
  accountId: string;
  showKey: boolean;
}

function PaneProviders({
  presets,
  keys,
  onAddKey,
  onRemoveKey,
  onAddCustomProvider,
  onRemoveCustomProvider,
}: PaneProvidersProps) {
  const [addingFor, setAddingFor] = useState<AddKeyFormState | null>(null);
  const [showCustomDialog, setShowCustomDialog] = useState(false);

  function openAddKey(preset: ProviderPreset) {
    setAddingFor({
      providerId: preset.id,
      rawKey: "",
      accountId: "",
      showKey: false,
    });
  }

  function cancelAdd() {
    setAddingFor(null);
  }

  function submitAdd() {
    if (!addingFor) return;
    const raw = addingFor.rawKey.trim();
    if (!raw) return;
    const preset = presets.find((p) => p.id === addingFor.providerId);
    const meta: Record<string, string> = {};
    if (preset?.requiresAccountId) {
      const acct = addingFor.accountId.trim();
      if (!acct) return;
      meta["accountId"] = acct;
    }
    onAddKey(addingFor.providerId, raw, Object.keys(meta).length ? meta : undefined);
    setAddingFor(null);
  }

  return (
    <div className={styles.pane}>
      <div className={styles.paneHeaderRow}>
        <h2 className={styles.paneTitle}>Providers</h2>
        <button
          className={styles.addBtn}
          onClick={() => setShowCustomDialog(true)}
        >
          <Plus size={13} />
          <span>Add custom</span>
        </button>
      </div>

      {presets.map((p) => {
        const isAdding = addingFor?.providerId === p.id;
        const preset = p;
        const needsAccountId = preset.requiresAccountId === true;

        return (
          <div key={p.id} className={styles.providerSection}>
            <div className={styles.providerHeader}>
              <span className={styles.providerName}>{p.name}</span>
              {!p.builtIn && (
                <button
                  className={styles.removeProviderBtn}
                  onClick={() => onRemoveCustomProvider(p.id)}
                  aria-label={`Remove ${p.name}`}
                  title={`Remove ${p.name}`}
                >
                  <Trash2 size={13} />
                </button>
              )}
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
                onClick={() => (isAdding ? cancelAdd() : openAddKey(p))}
              >
                <Plus size={13} />
                <span>Add key</span>
              </button>
            </div>

            {p.notes && <p className={styles.providerNotes}>{p.notes}</p>}

            {isAdding && addingFor && (
              <div className={styles.addKeyForm}>
                {needsAccountId && (
                  <div className={styles.addKeyFormField}>
                    <label className={styles.addKeyLabel} htmlFor={`acct-${p.id}`}>
                      Account ID <span className={styles.required}>*</span>
                    </label>
                    <input
                      id={`acct-${p.id}`}
                      className={styles.textInput}
                      type="text"
                      value={addingFor.accountId}
                      onChange={(e) =>
                        setAddingFor({ ...addingFor, accountId: e.target.value })
                      }
                      placeholder="e.g. a1b2c3d4e5f6..."
                      autoComplete="off"
                    />
                  </div>
                )}

                <div className={styles.addKeyFormField}>
                  <label className={styles.addKeyLabel} htmlFor={`key-${p.id}`}>
                    API key <span className={styles.required}>*</span>
                  </label>
                  <div className={styles.keyFieldRow}>
                    <input
                      id={`key-${p.id}`}
                      className={styles.textInput}
                      type={addingFor.showKey ? "text" : "password"}
                      value={addingFor.rawKey}
                      onChange={(e) =>
                        setAddingFor({ ...addingFor, rawKey: e.target.value })
                      }
                      placeholder="sk-…"
                      autoComplete="off"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") submitAdd();
                      }}
                    />
                    <button
                      className={styles.showToggle}
                      onClick={() =>
                        setAddingFor({ ...addingFor, showKey: !addingFor.showKey })
                      }
                      aria-label={addingFor.showKey ? "Hide key" : "Show key"}
                      type="button"
                    >
                      {addingFor.showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                </div>

                <div className={styles.addKeyActions}>
                  <button className={styles.cancelBtn} onClick={cancelAdd}>
                    Cancel
                  </button>
                  <button
                    className={styles.saveBtn}
                    onClick={submitAdd}
                    disabled={
                      !addingFor.rawKey.trim() ||
                      (needsAccountId && !addingFor.accountId.trim())
                    }
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
                    <span className={styles.keyMasked}>{k.maskedKey}</span>
                    {k.meta?.accountId && (
                      <span className={styles.keyMeta}>Account: {k.meta.accountId}</span>
                    )}
                  </div>
                  <KeyStatusBadge status={k.status} />
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
        );
      })}

      {showCustomDialog && (
        <CustomProviderDialog
          onSave={onAddCustomProvider}
          onClose={() => setShowCustomDialog(false)}
        />
      )}
    </div>
  );
}

// ── PaneModeSettings (shared between Cowork + Code) ────────────────────────

function FolderRow({
  mode,
  currentPath,
  onPickFolder,
}: {
  mode: Mode;
  currentPath: string | null;
  onPickFolder: (mode: Mode) => void;
}) {
  return (
    <div className={styles.folderRow}>
      <span className={styles.folderPath}>
        {currentPath ?? (
          <span className={styles.folderNone}>Not set — uses process directory</span>
        )}
      </span>
      <button
        className={styles.folderPickBtn}
        onClick={() => onPickFolder(mode)}
        aria-label="Pick default folder"
      >
        <FolderOpen size={13} />
        <span>Browse</span>
      </button>
    </div>
  );
}

function PaneCowork({
  settings,
  onSave,
  onPickFolder,
}: {
  settings: AppSettings;
  onSave: (patch: Partial<AppSettings>) => void;
  onPickFolder: (mode: Mode) => void;
}) {
  const c = settings.cowork;
  const cu = settings.computerUse;
  const br = settings.browser;

  function patch(k: keyof AppSettings["cowork"], v: unknown) {
    onSave({ cowork: { ...c, [k]: v } });
  }

  const modelSummary =
    c.selection.modelId
      ? c.selection.modelId
      : "No model selected (inherits from composer)";

  return (
    <div className={styles.pane}>
      <h2 className={styles.paneTitle}>Cowork</h2>

      <Field label="Model (read-only)" hint="Change via the composer model selector.">
        <div className={styles.modelReadonly}>{modelSummary}</div>
      </Field>

      <Field label="Max output tokens">
        <input
          className={styles.textInput}
          type="number"
          min={256}
          max={65536}
          step={256}
          value={c.maxTokens}
          onChange={(e) => patch("maxTokens", Number(e.target.value))}
        />
      </Field>

      <Field label="Temperature" hint="0 = deterministic, 1 = creative.">
        <input
          className={styles.textInput}
          type="number"
          min={0}
          max={2}
          step={0.05}
          value={c.temperature}
          onChange={(e) => patch("temperature", Number(e.target.value))}
        />
      </Field>

      <Field label="Max iterations" hint="Hard ceiling on tool-call rounds per user turn.">
        <input
          className={styles.textInput}
          type="number"
          min={1}
          max={500}
          step={1}
          value={c.maxIterations}
          onChange={(e) => patch("maxIterations", Number(e.target.value))}
        />
      </Field>

      <Field
        label="Default working folder"
        hint="Folder used when no project or session folder is active."
      >
        <FolderRow
          mode="cowork"
          currentPath={settings.general.defaultFolders.cowork}
          onPickFolder={onPickFolder}
        />
      </Field>

      <div className={styles.divider} />

      <Field
        label="Computer use"
        hint="Allow Kozum to control the desktop (mouse, keyboard, screenshots)."
      >
        <div className={styles.toggleRow}>
          <span className={styles.toggleRowLabel}>
            {cu.enabled ? "Enabled" : "Disabled"}
          </span>
          <Toggle
            checked={cu.enabled}
            onChange={(v) => onSave({ computerUse: { ...cu, enabled: v } })}
            label="Toggle computer use"
          />
        </div>
      </Field>

      <Field
        label="Browser access"
        hint="Allow Kozum to open and control a Chromium browser."
      >
        <div className={styles.toggleRow}>
          <span className={styles.toggleRowLabel}>
            {br.enabled ? "Enabled" : "Disabled"}
          </span>
          <Toggle
            checked={br.enabled}
            onChange={(v) => onSave({ browser: { ...br, enabled: v } })}
            label="Toggle browser access"
          />
        </div>
      </Field>
    </div>
  );
}

function PaneCode({
  settings,
  onSave,
  onPickFolder,
}: {
  settings: AppSettings;
  onSave: (patch: Partial<AppSettings>) => void;
  onPickFolder: (mode: Mode) => void;
}) {
  const cd = settings.code;

  function patch(k: keyof AppSettings["code"], v: unknown) {
    onSave({ code: { ...cd, [k]: v } });
  }

  const subagentOptions = [
    { value: "researcher", label: "Researcher" },
    { value: "tester", label: "Tester" },
    { value: "reviewer", label: "Code Reviewer" },
    { value: "documenter", label: "Documenter" },
  ];

  const enabledSubagents: string[] = cd.enabledToolNames ?? subagentOptions.map((o) => o.value);

  function toggleSubagent(id: string) {
    const next = enabledSubagents.includes(id)
      ? enabledSubagents.filter((x) => x !== id)
      : [...enabledSubagents, id];
    patch("enabledToolNames", next);
  }

  const modelSummary =
    cd.selection.modelId
      ? cd.selection.modelId
      : "No model selected (inherits from composer)";

  return (
    <div className={styles.pane}>
      <h2 className={styles.paneTitle}>Code</h2>

      <Field label="Model (read-only)" hint="Change via the composer model selector.">
        <div className={styles.modelReadonly}>{modelSummary}</div>
      </Field>

      <Field label="Max output tokens">
        <input
          className={styles.textInput}
          type="number"
          min={256}
          max={65536}
          step={256}
          value={cd.maxTokens}
          onChange={(e) => patch("maxTokens", Number(e.target.value))}
        />
      </Field>

      <Field label="Temperature" hint="0 = deterministic — strongly recommended for code.">
        <input
          className={styles.textInput}
          type="number"
          min={0}
          max={2}
          step={0.05}
          value={cd.temperature}
          onChange={(e) => patch("temperature", Number(e.target.value))}
        />
      </Field>

      <Field label="Max iterations" hint="Hard ceiling on tool-call rounds per user turn.">
        <input
          className={styles.textInput}
          type="number"
          min={1}
          max={500}
          step={1}
          value={cd.maxIterations}
          onChange={(e) => patch("maxIterations", Number(e.target.value))}
        />
      </Field>

      <Field
        label="Default working folder"
        hint="Folder Kozum opens by default when you start a new Code session."
      >
        <FolderRow
          mode="code"
          currentPath={settings.general.defaultFolders.code}
          onPickFolder={onPickFolder}
        />
      </Field>

      <div className={styles.divider} />

      <Field
        label="Default permission mode"
        hint="Sets the starting posture for new Code sessions."
      >
        <Select
          value={cd.permissionMode}
          onChange={(v) => patch("permissionMode", v)}
          options={[
            { value: "accept_all", label: "Accept all — no confirmations" },
            { value: "accept_edits", label: "Accept edits — shell still asks" },
            { value: "ask", label: "Ask — confirm every action" },
            { value: "reject", label: "Reject — block all changes" },
          ]}
        />
      </Field>

      <Field
        label="Auto-build project knowledge base"
        hint="When opening a folder, index its source files into a searchable knowledge graph."
      >
        <div className={styles.toggleRow}>
          <span className={styles.toggleRowLabel}>
            {cd.enabledToolNames !== null ? "Custom" : "Enabled (default)"}
          </span>
          <Toggle
            checked={cd.enabledToolNames === null}
            onChange={(v) => patch("enabledToolNames", v ? null : enabledSubagents)}
            label="Toggle auto-build knowledge base"
          />
        </div>
      </Field>

      <Field
        label="Engineering subagents"
        hint="Which specialised subagents are available during Code sessions."
      >
        <ul className={styles.subagentList}>
          {subagentOptions.map((sa) => (
            <li key={sa.value} className={styles.subagentItem}>
              <span className={styles.subagentLabel}>{sa.label}</span>
              <Toggle
                checked={enabledSubagents.includes(sa.value)}
                onChange={() => toggleSubagent(sa.value)}
                label={`Toggle ${sa.label}`}
              />
            </li>
          ))}
        </ul>
      </Field>
    </div>
  );
}

// ── PaneToggleList (Skills / Connectors / Plugins) ─────────────────────────

function PaneToggleList({
  title,
  items,
  onToggle,
  onAdd,
  onRemove,
  onInspect,
}: {
  title: string;
  items: Array<{ id: string; name: string; description: string; enabled: boolean }>;
  onToggle: (id: string, enabled: boolean) => void;
  onAdd: () => void;
  /** Optional per-row remove (used for connectors/plugins). */
  onRemove?: (id: string) => void;
  /** Optional per-row inspect — opens a details view (used for connectors/plugins). */
  onInspect?: (id: string) => void;
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
              {onInspect && (
                <button
                  type="button"
                  className={styles.toggleInspectBtn}
                  onClick={() => onInspect(item.id)}
                  aria-label={`Inspect ${item.name}`}
                  title="Inspect"
                >
                  <Info size={14} />
                </button>
              )}
              <button
                className={styles.toggleBtn}
                onClick={() => onToggle(item.id, !item.enabled)}
                aria-label={item.enabled ? `Disable ${item.name}` : `Enable ${item.name}`}
                aria-pressed={item.enabled}
              >
                {item.enabled ? (
                  <ToggleRight size={22} className={styles.toggleOn} />
                ) : (
                  <ToggleLeft size={22} className={styles.toggleOff} />
                )}
              </button>
              {onRemove && (
                <button
                  type="button"
                  className={styles.toggleRemoveBtn}
                  onClick={() => {
                    if (confirm(`Remove ${item.name}?`)) onRemove(item.id);
                  }}
                  aria-label={`Remove ${item.name}`}
                  title="Remove"
                >
                  <Trash2 size={13} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Main modal ─────────────────────────────────────────────────────────────

export interface SettingsProps {
  settings: AppSettings;
  presets: ProviderPreset[];
  keys: Record<string, ApiKeyEntry[]>;
  skills: Skill[];
  connectors: McpServerConfig[];
  plugins: Plugin[];
  /** Current value of the rules textarea (load from memory.getRules). */
  rules: string;
  onRulesChange: (v: string) => void;
  /** Called on blur — caller should call memory.setRules(). */
  onRulesBlur: () => void;
  onSave: (patch: Partial<AppSettings>) => void;
  /**
   * Called when the user clicks "Add key". Label is always ""; pass rawKey and
   * optional meta. Caller calls bridge().providers.addKey(providerId, "", rawKey, meta).
   */
  onAddKey: (
    providerId: string,
    rawKey: string,
    meta?: Record<string, string>,
  ) => void;
  onRemoveKey: (keyId: string) => void;
  onAddCustomProvider: (name: string, baseUrl: string) => Promise<void>;
  onRemoveCustomProvider: (id: string) => void;
  onToggleSkill: (id: string, enabled: boolean) => void;
  onToggleConnector: (id: string, enabled: boolean) => void;
  onTogglePlugin: (id: string, enabled: boolean) => void;
  onAddSkill: () => void;
  onAddConnector: () => void;
  onAddPlugin: () => void;
  /** Optional remove handlers for connectors and plugins (best-effort). */
  onRemoveConnector?: (id: string) => void;
  onRemovePlugin?: (id: string) => void;
  /** Optional inspect handlers for connectors and plugins (best-effort). */
  onInspectConnector?: (id: string) => void;
  onInspectPlugin?: (id: string) => void;
  /**
   * Called when the user clicks "Browse" for a default folder.
   * Caller should: dialog.selectFolder() → save to settings.general.defaultFolders[mode].
   */
  onPickFolder: (mode: Mode) => void;
  onClose: () => void;
  /** Optional: which pane to open on mount. Defaults to "general". */
  initialPane?: NavId;
}

export function Settings({
  settings,
  presets,
  keys,
  skills,
  connectors,
  plugins,
  rules,
  onRulesChange,
  onRulesBlur,
  onSave,
  onAddKey,
  onRemoveKey,
  onAddCustomProvider,
  onRemoveCustomProvider,
  onToggleSkill,
  onToggleConnector,
  onTogglePlugin,
  onAddSkill,
  onAddConnector,
  onAddPlugin,
  onRemoveConnector,
  onRemovePlugin,
  onInspectConnector,
  onInspectPlugin,
  onPickFolder,
  onClose,
  initialPane = "general",
}: SettingsProps) {
  const [activeNav, setActiveNav] = useState<NavId>(initialPane);
  const [navSearch, setNavSearch] = useState("");

  // Apply theme/motion/font to the document whenever settings change.
  useTheme(settings);

  const filteredNav = useMemo(
    () => NAV.filter((n) => n.label.toLowerCase().includes(navSearch.toLowerCase())),
    [navSearch],
  );

  const handleAddCustomProvider = useCallback(
    async (name: string, baseUrl: string) => {
      await onAddCustomProvider(name, baseUrl);
    },
    [onAddCustomProvider],
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
              <PaneGeneral
                settings={settings}
                rules={rules}
                onRulesChange={onRulesChange}
                onRulesBlur={onRulesBlur}
                onChange={onSave}
              />
            )}
            {activeNav === "providers" && (
              <PaneProviders
                presets={presets}
                keys={keys}
                onAddKey={onAddKey}
                onRemoveKey={onRemoveKey}
                onAddCustomProvider={handleAddCustomProvider}
                onRemoveCustomProvider={onRemoveCustomProvider}
              />
            )}
            {activeNav === "cowork" && (
              <PaneCowork settings={settings} onSave={onSave} onPickFolder={onPickFolder} />
            )}
            {activeNav === "code" && (
              <PaneCode settings={settings} onSave={onSave} onPickFolder={onPickFolder} />
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
                onRemove={onRemoveConnector}
                onInspect={onInspectConnector}
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
                onRemove={onRemovePlugin}
                onInspect={onInspectPlugin}
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
