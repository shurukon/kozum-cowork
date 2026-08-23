import { useMemo, useState } from "react";
import {
  ArrowLeft,
  Check,
  Eye,
  EyeOff,
  KeyRound,
  Monitor,
  Plug,
  Save,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  UserRound,
  Volume2,
  WandSparkles,
  X,
} from "lucide-react";
import type {
  ApiKeyEntry,
  AppSettings,
  PermissionMode,
  ProviderPreset,
} from "@shared/types.ts";
import styles from "./SettingsPage.module.css";
import logoUrl from "../assets/kozum-logo.png";

export interface SettingsPageProps {
  settings: AppSettings;
  presets: ProviderPreset[];
  keys: Record<string, ApiKeyEntry[]>;
  rules: string;
  onRulesChange: (value: string) => void;
  onRulesBlur: () => void;
  onSave: (patch: Partial<AppSettings>) => void;
  onAddKey: (providerId: string, rawKey: string, meta?: Record<string, string>) => void;
  onRemoveKey: (keyId: string) => void;
  onAddCustomProvider: (input: {
    name: string;
    baseUrl: string;
    protocol?: "openai-chat" | "openai-responses" | "anthropic-messages";
    /** Comma/newline-separated model IDs stored as the preset's static list. */
    modelIds?: string[];
    apiKey?: string;
  }) => Promise<void>;
  onRemoveCustomProvider: (id: string) => void;
  onPickFolder: (mode: "cowork" | "code") => void;
  /** Pick the shared default workspace (changeable, never removable). */
  onPickWorkspaceFolder: () => void;
  onBack: () => void;
}

type Section = "profile" | "preferences" | "providers" | "privacy" | "browser" | "sandbox" | "voice" | "about";

const NAV: Array<{ id: Section; label: string; icon: typeof UserRound }> = [
  { id: "profile", label: "Profile", icon: UserRound },
  { id: "preferences", label: "Preferences", icon: SlidersHorizontal },
  { id: "providers", label: "AI providers", icon: KeyRound },
  { id: "privacy", label: "Privacy & permissions", icon: Shield },
  { id: "browser", label: "Browser", icon: Monitor },
  { id: "sandbox", label: "Sandbox", icon: WandSparkles },
  { id: "voice", label: "Voice", icon: Volume2 },
  { id: "about", label: "About", icon: Sparkles },
];

function Toggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: (value: boolean) => void }) {
  return (
    <button
      type="button"
      className={`${styles.toggle} ${checked ? styles.toggleOn : ""}`}
      aria-pressed={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
    >
      <span className={styles.toggleThumb} />
    </button>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className={styles.field}>
      <div className={styles.fieldCopy}>
        <label className={styles.label}>{label}</label>
        {hint && <span className={styles.hint}>{hint}</span>}
      </div>
      <div className={styles.control}>{children}</div>
    </div>
  );
}

function SectionHeader({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return (
    <header className={styles.sectionHeader}>
      <span className={styles.eyebrow}>{eyebrow}</span>
      <h1>{title}</h1>
      <p>{description}</p>
    </header>
  );
}

function maskKey(key: ApiKeyEntry): string {
  return key.maskedKey || "••••••••";
}

function ProvidersSection({
  presets,
  keys,
  onAddKey,
  onRemoveKey,
  onAddCustomProvider,
  onRemoveCustomProvider,
}: Pick<SettingsPageProps, "presets" | "keys" | "onAddKey" | "onRemoveKey" | "onAddCustomProvider" | "onRemoveCustomProvider">) {
  const [addingProvider, setAddingProvider] = useState<string | null>(null);
  const [keyValue, setKeyValue] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customUrl, setCustomUrl] = useState("");
  const [customKey, setCustomKey] = useState("");
  const [customModels, setCustomModels] = useState("");
  const [customProtocol, setCustomProtocol] = useState<"openai-chat" | "openai-responses" | "anthropic-messages">("openai-chat");
  const [savingCustom, setSavingCustom] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submitKey = (provider: ProviderPreset) => {
    const raw = keyValue.trim();
    if (!raw) return;
    onAddKey(provider.id, raw);
    setKeyValue("");
    setShowKey(false);
    setAddingProvider(null);
  };

  const submitCustom = async () => {
    const name = customName.trim();
    const url = customUrl.trim();
    if (!name || !url) return;
    setSavingCustom(true);
    setError(null);
    try {
      await onAddCustomProvider({
        name,
        baseUrl: url,
        protocol: customProtocol,
        modelIds: customModels.split(/[,\n]/).map((m) => m.trim()).filter(Boolean),
        apiKey: customKey.trim() || undefined,
      });
      setCustomName("");
      setCustomUrl("");
      setCustomKey("");
      setCustomModels("");
      setCustomProtocol("openai-chat");
      setCustomOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSavingCustom(false);
    }
  };

  return (
    <>
      <SectionHeader
        eyebrow="Configuration"
        title="AI providers"
        description="Manage encrypted credentials and the models available to Cowork and Code. Raw API keys never leave the main process."
      />
      <div className={styles.actionRow}>
        <span className={styles.statusPill}><Check size={13} /> Keys are stored securely</span>
        <button type="button" className={styles.secondaryButton} onClick={() => setCustomOpen((value) => !value)}>
          <Plug size={14} /> Add provider
        </button>
      </div>
      {customOpen && (
        <div className={styles.inlineCard}>
          <div className={styles.inlineTitle}>Custom provider</div>
          <div className={styles.inlineGrid}>
            <input className={styles.input} placeholder="Provider name" value={customName} onChange={(event) => setCustomName(event.target.value)} />
            <input className={styles.input} placeholder="https://api.example.com/v1" value={customUrl} onChange={(event) => setCustomUrl(event.target.value)} />
            <select className={styles.input} value={customProtocol} onChange={(event) => setCustomProtocol(event.target.value as typeof customProtocol)} aria-label="Wire protocol">
              <option value="openai-chat">OpenAI Chat Completions</option>
              <option value="openai-responses">OpenAI Responses</option>
              <option value="anthropic-messages">Anthropic Messages</option>
            </select>
            <input className={styles.input} type="password" placeholder="API key (optional — can be added later)" value={customKey} onChange={(event) => setCustomKey(event.target.value)} />
          </div>
          <textarea
            className={styles.textarea}
            rows={2}
            placeholder="Model IDs, comma or newline separated (e.g. my-model, my-model-mini). Used as the fallback list when /models is unreachable."
            value={customModels}
            onChange={(event) => setCustomModels(event.target.value)}
            aria-label="Model IDs"
          />
          {error && <p className={styles.error}>{error}</p>}
          <div className={styles.inlineActions}>
            <button type="button" className={styles.ghostButton} onClick={() => setCustomOpen(false)}>Cancel</button>
            <button type="button" className={styles.primaryButton} disabled={savingCustom || !customName.trim() || !customUrl.trim()} onClick={() => void submitCustom()}>
              {savingCustom ? "Adding…" : "Add provider"}
            </button>
          </div>
        </div>
      )}
      <div className={styles.providerList}>
        {presets.map((provider) => {
          const providerKeys = keys[provider.id] ?? [];
          const isAdding = addingProvider === provider.id;
          return (
            <article key={provider.id} className={styles.providerCard}>
              <div className={styles.providerTop}>
                <div>
                  <div className={styles.providerName}>{provider.name}</div>
                  <div className={styles.providerMeta}>{provider.protocol} · {provider.baseUrl}</div>
                </div>
                <span className={`${styles.statusPill} ${providerKeys.length ? styles.statusGood : styles.statusMuted}`}>
                  <span className={styles.statusDot} /> {providerKeys.length ? "Configured" : "Not configured"}
                </span>
              </div>
              {provider.notes && <p className={styles.providerNote}>{provider.notes}</p>}
              <div className={styles.keyRows}>
                {providerKeys.map((key) => (
                  <div className={styles.keyRow} key={key.id}>
                    <span><KeyRound size={13} /> {maskKey(key)}</span>
                    <span className={styles.keyStatus}>{key.status}</span>
                    <button type="button" className={styles.iconButton} aria-label={`Remove ${provider.name} key`} onClick={() => onRemoveKey(key.id)}><Trash2 size={14} /></button>
                  </div>
                ))}
                {isAdding && (
                  <div className={styles.keyAddRow}>
                    <div className={styles.keyInputWrap}>
                      <input autoFocus className={styles.input} type={showKey ? "text" : "password"} value={keyValue} onChange={(event) => setKeyValue(event.target.value)} placeholder="Paste API key" onKeyDown={(event) => { if (event.key === "Enter") submitKey(provider); }} />
                      <button type="button" className={styles.inputIcon} onClick={() => setShowKey((value) => !value)} aria-label={showKey ? "Hide API key" : "Show API key"}>{showKey ? <EyeOff size={14} /> : <Eye size={14} />}</button>
                    </div>
                    <button type="button" className={styles.primaryButton} disabled={!keyValue.trim()} onClick={() => submitKey(provider)}>Save key</button>
                    <button type="button" className={styles.ghostButton} onClick={() => setAddingProvider(null)}>Cancel</button>
                  </div>
                )}
              </div>
              {!isAdding && (
                <button type="button" className={styles.linkButton} onClick={() => { setAddingProvider(provider.id); setKeyValue(""); }}>
                  <KeyRound size={13} /> Add API key
                </button>
              )}
              {!provider.builtIn && (
                <button type="button" className={styles.removeProvider} onClick={() => onRemoveCustomProvider(provider.id)}>
                  <Trash2 size={13} /> Remove custom provider
                </button>
              )}
            </article>
          );
        })}
      </div>
    </>
  );
}

function SettingsSection({
  section,
  settings,
  rules,
  onRulesChange,
  onRulesBlur,
  onSave,
  onPickFolder,
  onPickWorkspaceFolder,
  ...providerProps
}: { section: Section; settings: AppSettings; rules: string; onRulesChange: (value: string) => void; onRulesBlur: () => void; onSave: (patch: Partial<AppSettings>) => void; onPickFolder: (mode: "cowork" | "code") => void; onPickWorkspaceFolder: () => void } & Pick<SettingsPageProps, "presets" | "keys" | "onAddKey" | "onRemoveKey" | "onAddCustomProvider" | "onRemoveCustomProvider">) {
  const general = settings.general;
  const patchGeneral = (patch: Partial<AppSettings["general"]>) => onSave({ general: { ...general, ...patch } });

  if (section === "providers") return <ProvidersSection {...providerProps} />;
  if (section === "profile") {
    return <>
      <SectionHeader eyebrow="Account" title="Profile" description="The local profile used to personalise Kozum's workspace and task summaries." />
      <div className={styles.profileCard}><div className={styles.avatar}><UserRound size={22} /></div><div><strong>{general.userName || "Your profile"}</strong><span>{general.workDescription || "Add a role or description below."}</span></div></div>
      <div className={styles.card}>
        <Field label="Display name" hint="Shown in the workspace and generated task summaries."><input className={styles.input} value={general.userName} onChange={(event) => patchGeneral({ userName: event.target.value })} placeholder="Your name" /></Field>
        <Field label="What you do" hint="Helps Kozum choose relevant defaults."><input className={styles.input} value={general.workDescription} onChange={(event) => patchGeneral({ workDescription: event.target.value })} placeholder="e.g. Product engineer" /></Field>
        <div className={styles.formActions}><button type="button" className={styles.primaryButton}><Save size={14} /> Changes save automatically</button></div>
      </div>
    </>;
  }
  if (section === "preferences") {
    return <>
      <SectionHeader eyebrow="Workspace" title="Preferences" description="Control the visual language and behaviour of the Kozum workspace." />
      <div className={styles.card}>
        <Field label="Default workspace" hint="Used by Cowork and Code whenever no project or folder is selected. Changeable, never removable."><div className={styles.folderRow}><span>{settings.general.defaultWorkspace ?? "Not set"}</span><button type="button" className={styles.secondaryButton} onClick={onPickWorkspaceFolder}>Change folder</button></div></Field>
        <Field label="Theme"><select className={styles.input} value={general.appearance} onChange={(event) => patchGeneral({ appearance: event.target.value as AppSettings["general"]["appearance"] })}><option value="system">System</option><option value="dark">Dark</option><option value="light">Light</option></select></Field>
        <Field label="Language"><select className={styles.input} value={general.language} onChange={(event) => patchGeneral({ language: event.target.value as "en" | "ar" })}><option value="en">English</option><option value="ar">العربية</option></select></Field>
        <Field label="Chat font"><select className={styles.input} value={general.chatFont} onChange={(event) => patchGeneral({ chatFont: event.target.value as AppSettings["general"]["chatFont"] })}><option value="sans">DM Sans</option><option value="serif">Serif</option><option value="mono">JetBrains Mono</option></select></Field>
        <Field label="Motion" hint="Reduced motion removes non-essential transitions."><select className={styles.input} value={general.motion} onChange={(event) => patchGeneral({ motion: event.target.value as AppSettings["general"]["motion"] })}><option value="system">System</option><option value="reduced">Reduced</option></select></Field>
        <Field label="Auto-open previews"><Toggle checked={general.autoOpenPreviews} label="Auto-open previews" onChange={(value) => patchGeneral({ autoOpenPreviews: value })} /></Field>
        <Field label="Live browser preview"><Toggle checked={general.autoOpenBrowserPreview} label="Live browser preview" onChange={(value) => patchGeneral({ autoOpenBrowserPreview: value })} /></Field>
        <Field label="Standing rules" hint="Applied to every new task. Saved when the field loses focus."><textarea className={styles.textarea} value={rules} onChange={(event) => onRulesChange(event.target.value)} onBlur={onRulesBlur} rows={6} placeholder="Never truncate code. Always verify changes." /></Field>
      </div>
    </>;
  }
  if (section === "privacy") {
    return <>
      <SectionHeader eyebrow="Safety" title="Privacy & permissions" description="Kozum keeps credentials local and makes Code's action posture explicit." />
      <div className={styles.card}>
        <Field label="Code default permission" hint="Controls new Code sessions. Existing sessions keep their own mode."><select className={styles.input} value={settings.code.permissionMode} onChange={(event) => onSave({ code: { ...settings.code, permissionMode: event.target.value as PermissionMode } })}><option value="bypass_permissions">bypass permissions</option><option value="plan">plan</option><option value="accept_edits">accept edits</option><option value="ask_permission">ask permission</option></select></Field>
        <Field label="Computer use"><Toggle checked={settings.computerUse.enabled} label="Computer use" onChange={(value) => onSave({ computerUse: { ...settings.computerUse, enabled: value } })} /></Field>
        <Field label="Require confirmation for computer use"><Toggle checked={settings.computerUse.requireConfirmation} label="Require computer confirmation" onChange={(value) => onSave({ computerUse: { ...settings.computerUse, requireConfirmation: value } })} /></Field>
      </div>
      <div className={styles.card}><div className={styles.cardTitle}>Stored credentials</div><p className={styles.cardText}>API keys are encrypted in the main process. This page only receives masked entries and never renders a secret value.</p></div>
    </>;
  }
  if (section === "browser") {
    return <>
      <SectionHeader eyebrow="Computer access" title="Browser" description="Set the safe defaults for Kozum's internal browser and live preview." />
      <div className={styles.card}>
        <Field label="Browser access"><Toggle checked={settings.browser.enabled} label="Browser access" onChange={(value) => onSave({ browser: { ...settings.browser, enabled: value } })} /></Field>
        <Field label="Headless mode"><Toggle checked={settings.browser.headless} label="Headless browser" onChange={(value) => onSave({ browser: { ...settings.browser, headless: value } })} /></Field>
        <Field label="User agent" hint="Leave empty to use Kozum's managed Chromium user agent."><input className={styles.input} value={settings.browser.userAgent ?? ""} onChange={(event) => onSave({ browser: { ...settings.browser, userAgent: event.target.value || null } })} placeholder="Managed default" /></Field>
        <Field label="Default Cowork folder"><div className={styles.folderRow}><span>{general.defaultFolders.cowork ?? "Not set"}</span><button type="button" className={styles.secondaryButton} onClick={() => onPickFolder("cowork")}>Choose folder</button></div></Field>
        <Field label="Default Code folder"><div className={styles.folderRow}><span>{general.defaultFolders.code ?? "Not set"}</span><button type="button" className={styles.secondaryButton} onClick={() => onPickFolder("code")}>Choose folder</button></div></Field>
      </div>
    </>;
  }
  if (section === "sandbox") {
    return <>
      <SectionHeader eyebrow="Execution" title="Sandbox" description="Review the boundaries used by tools, scheduling, and project execution." />
      <div className={styles.card}>
        <Field label="Scheduler"><Toggle checked={settings.scheduler.enabled} label="Scheduler" onChange={(value) => onSave({ scheduler: { ...settings.scheduler, enabled: value } })} /></Field>
        <Field label="Keep the app awake"><Toggle checked={settings.scheduler.keepAwake} label="Keep awake" onChange={(value) => onSave({ scheduler: { ...settings.scheduler, keepAwake: value } })} /></Field>
        <Field label="GitHub firewall rule"><Toggle checked={settings.network.githubFirewallRule} label="GitHub firewall rule" onChange={(value) => onSave({ network: { ...settings.network, githubFirewallRule: value } })} /></Field>
        <Field label="Allowed network hosts" hint="One host per line."><textarea className={styles.textarea} value={settings.network.alwaysAllowHosts.join("\n")} onChange={(event) => onSave({ network: { ...settings.network, alwaysAllowHosts: event.target.value.split(/\n/).map((value) => value.trim()).filter(Boolean) } })} rows={4} /></Field>
      </div>
    </>;
  }
  if (section === "voice") {
    return <>
      <SectionHeader eyebrow="Accessibility" title="Voice" description="Voice tools are exposed through configured providers and remain opt-in per task." />
      <div className={styles.card}><div className={styles.emptyState}><Volume2 size={24} /><strong>No local voice provider configured</strong><span>Add a provider or enable a voice-capable skill from Customize. Kozum will not fabricate a voice service or store audio without an explicit tool call.</span></div></div>
    </>;
  }
  return <>
    <SectionHeader eyebrow="Kozum Cowork" title="About" description="Open-source workspace automation with separate Cowork and Code execution surfaces." />
    <div className={styles.aboutGrid}><div className={styles.aboutStat}><strong>Kozum</strong><span>Open-source desktop agent</span></div><div className={styles.aboutStat}><strong>Local-first</strong><span>Secrets stay in the main process</span></div><div className={styles.aboutStat}><strong>Two modes</strong><span>Cowork and Code remain isolated</span></div></div>
    <div className={styles.card}><div className={styles.cardTitle}>Runtime health</div><p className={styles.cardText}>Provider status and model availability are shown in AI providers. Tool execution results remain visible inside each conversation.</p></div>
  </>;
}

export function SettingsPage(props: SettingsPageProps) {
  const [section, setSection] = useState<Section>("profile");
  const [query, setQuery] = useState("");
  const visibleNav = useMemo(() => NAV.filter((item) => item.label.toLowerCase().includes(query.toLowerCase())), [query]);

  return (
    <div className={styles.page}>
      <aside className={styles.sidebar}>
        <button type="button" className={styles.backButton} onClick={props.onBack}><ArrowLeft size={15} /> Back to workspace</button>
        <div className={styles.brand}><img src={logoUrl} alt="Kozum AI" /><div><strong>Kozum AI</strong><span>Settings</span></div></div>
        <div className={styles.search}><SlidersHorizontal size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search settings" aria-label="Search settings" /></div>
        <nav className={styles.nav} aria-label="Settings sections">
          {visibleNav.map(({ id, label, icon: Icon }) => <button type="button" key={id} className={`${styles.navItem} ${section === id ? styles.navActive : ""}`} onClick={() => setSection(id)}><Icon size={15} /><span>{label}</span></button>)}
        </nav>
        <div className={styles.sidebarFooter}><span>Settings are saved instantly</span><span className={styles.footerDot} /></div>
      </aside>
      <main className={styles.main}>
        <div className={styles.topBar}><span className={styles.breadcrumb}>Settings <span>/</span> {NAV.find((item) => item.id === section)?.label}</span><button type="button" className={styles.iconButton} onClick={props.onBack} aria-label="Close settings"><X size={17} /></button></div>
        <div className={styles.content}>
          <SettingsSection section={section} settings={props.settings} rules={props.rules} onRulesChange={props.onRulesChange} onRulesBlur={props.onRulesBlur} onSave={props.onSave} onPickFolder={props.onPickFolder} onPickWorkspaceFolder={props.onPickWorkspaceFolder} presets={props.presets} keys={props.keys} onAddKey={props.onAddKey} onRemoveKey={props.onRemoveKey} onAddCustomProvider={props.onAddCustomProvider} onRemoveCustomProvider={props.onRemoveCustomProvider} />
        </div>
      </main>
    </div>
  );
}
