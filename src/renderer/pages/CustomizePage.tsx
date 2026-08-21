import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, Code2, Palette, Package, Plug, Plus, Save, Sparkles, Trash2, WandSparkles } from "lucide-react";
import type { AppSettings, McpServerConfig, Mode, Plugin, Skill } from "@shared/types.ts";
import styles from "./CustomizePage.module.css";
import logoUrl from "../assets/kozum-logo.png";

export interface CustomizePageProps {
  settings: AppSettings;
  skills: Skill[];
  connectors: McpServerConfig[];
  plugins: Plugin[];
  onSave: (patch: Partial<AppSettings>) => void;
  onToggleSkill: (id: string, enabled: boolean) => void;
  onToggleConnector: (id: string, enabled: boolean) => void;
  onTogglePlugin: (id: string, enabled: boolean) => void;
  onRemoveConnector: (id: string) => void;
  onRemovePlugin: (id: string) => void;
  onAddConnector: () => void;
  onAddPlugin: () => void;
  onBack: () => void;
  initialTab?: CustomizeTab;
}

export type CustomizeTab = "system" | "appearance" | "skills" | "mcp" | "plugins";

function Toggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: (value: boolean) => void }) {
  return <button type="button" className={`${styles.toggle} ${checked ? styles.toggleOn : ""}`} aria-label={label} aria-pressed={checked} onClick={() => onChange(!checked)}><span /></button>;
}

function ModePill({ mode, active, onClick }: { mode: Mode; active: boolean; onClick: () => void }) {
  return <button type="button" className={`${styles.modePill} ${active ? styles.modePillActive : ""}`} onClick={onClick}>{mode === "cowork" ? <Sparkles size={13} /> : <Code2 size={13} />}{mode === "cowork" ? "Cowork" : "Code"}</button>;
}

function Header({ tab }: { tab: CustomizeTab }) {
  const labels: Record<CustomizeTab, [string, string, string]> = {
    system: ["Agent behaviour", "System prompt", "Shape how Kozum thinks and hands off work without changing the core safety contract."],
    appearance: ["Visual language", "Appearance", "Tune the typography and colour accents used throughout your workspace."],
    skills: ["Extensions", "Skills", "Enable only the skills that should be available to the current agent modes."],
    mcp: ["Extensions", "MCP servers", "Connect external tool servers with explicit enablement and visible status."],
    plugins: ["Extensions", "Plugins", "Review installed plugins and the skills, agents, commands, and servers they contribute."],
  };
  const [eyebrow, title, description] = labels[tab];
  return <header className={styles.header}><span className={styles.eyebrow}>{eyebrow}</span><h1>{title}</h1><p>{description}</p></header>;
}

export function CustomizePage({ settings, skills, connectors, plugins, onSave, onToggleSkill, onToggleConnector, onTogglePlugin, onRemoveConnector, onRemovePlugin, onAddConnector, onAddPlugin, onBack, initialTab = "system" }: CustomizePageProps) {
  const [tab, setTab] = useState<CustomizeTab>(initialTab);
  const [mode, setMode] = useState<Mode>("cowork");
  const [prompt, setPrompt] = useState(settings.cowork.systemPromptOverride ?? "");
  const [instructions, setInstructions] = useState(settings.general.customInstructions);
  const [accent, setAccent] = useState(settings.customize?.accentColor ?? "#68c8ed");
  const [surface, setSurface] = useState(settings.customize?.surfaceColor ?? "#101923");
  const [font, setFont] = useState(settings.customize?.fontFamily ?? settings.general.chatFont);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setPrompt(mode === "cowork" ? settings.cowork.systemPromptOverride ?? "" : settings.code.systemPromptOverride ?? "");
  }, [mode, settings.code.systemPromptOverride, settings.cowork.systemPromptOverride]);

  const enabledSkills = useMemo(() => skills.filter((skill) => skill.enabled).length, [skills]);
  const enabledConnectors = useMemo(() => connectors.filter((server) => server.enabled).length, [connectors]);
  const enabledPlugins = useMemo(() => plugins.filter((plugin) => plugin.enabled).length, [plugins]);

  function saveSystem() {
    onSave({
      general: { ...settings.general, customInstructions: instructions },
      [mode]: { ...settings[mode], systemPromptOverride: prompt || null },
    });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1600);
  }

  function saveAppearance() {
    onSave({
      general: { ...settings.general, chatFont: font === "mono" ? "mono" : font === "serif" ? "serif" : "sans" },
      customize: { ...(settings.customize ?? { accentColor: "#68c8ed", surfaceColor: "#101923", fontFamily: "sans" }), accentColor: accent, surfaceColor: surface, fontFamily: font },
    });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1600);
  }

  return (
    <div className={styles.page}>
      <aside className={styles.sidebar}>
        <button type="button" className={styles.backButton} onClick={onBack}><ArrowLeft size={15} /> Back to workspace</button>
        <div className={styles.brand}><img src={logoUrl} alt="Kozum AI" /><div><strong>Kozum AI</strong><span>Customize</span></div></div>
        <div className={styles.modeSwitch}><span className={styles.modeTitle}>Active surface</span><div className={styles.modeRow}><ModePill mode="cowork" active={mode === "cowork"} onClick={() => setMode("cowork")} /><ModePill mode="code" active={mode === "code"} onClick={() => setMode("code")} /></div></div>
        <nav className={styles.nav} aria-label="Customize sections">
          <button type="button" className={`${styles.navItem} ${tab === "system" ? styles.navActive : ""}`} onClick={() => setTab("system")}><WandSparkles size={15} /><span>System prompt</span></button>
          <button type="button" className={`${styles.navItem} ${tab === "appearance" ? styles.navActive : ""}`} onClick={() => setTab("appearance")}><Palette size={15} /><span>Colors & fonts</span></button>
          <div className={styles.navLabel}>Extensions</div>
          <button type="button" className={`${styles.navItem} ${tab === "skills" ? styles.navActive : ""}`} onClick={() => setTab("skills")}><Sparkles size={15} /><span>Skills <em>{enabledSkills}</em></span></button>
          <button type="button" className={`${styles.navItem} ${tab === "mcp" ? styles.navActive : ""}`} onClick={() => setTab("mcp")}><Plug size={15} /><span>MCP servers <em>{enabledConnectors}</em></span></button>
          <button type="button" className={`${styles.navItem} ${tab === "plugins" ? styles.navActive : ""}`} onClick={() => setTab("plugins")}><Package size={15} /><span>Plugins <em>{enabledPlugins}</em></span></button>
        </nav>
        <div className={styles.sidebarFooter}>Customize is mode-aware <span /></div>
      </aside>
      <main className={styles.main}>
        <div className={styles.topBar}><span className={styles.breadcrumb}>Customize <span>/</span> {tab === "mcp" ? "MCP servers" : tab[0].toUpperCase() + tab.slice(1)}</span><button type="button" className={styles.closeButton} onClick={onBack}>Done</button></div>
        <div className={styles.content}>
          <Header tab={tab} />
          {tab === "system" && <section className={styles.card}>
            <div className={styles.modeHeading}><div><strong>{mode === "cowork" ? "Cowork instructions" : "Code instructions"}</strong><span>Applied to this mode only. Core safety rules and tool contracts remain enforced.</span></div><span className={styles.livePill}><Check size={12} /> Live</span></div>
            <label className={styles.label} htmlFor="mode-system-prompt">Mode system prompt override</label>
            <textarea id="mode-system-prompt" className={styles.textarea} value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={11} placeholder="Add a concise instruction for this mode, or leave blank to use Kozum's built-in prompt." />
            <label className={styles.label} htmlFor="workspace-instructions">Workspace instructions</label>
            <textarea id="workspace-instructions" className={styles.textarea} value={instructions} onChange={(event) => setInstructions(event.target.value)} rows={7} placeholder="Describe your preferred output style, conventions, and acceptance checks." />
            <div className={styles.actionRow}><span className={styles.note}>Changes affect new turns and are persisted locally.</span><button type="button" className={styles.primaryButton} onClick={saveSystem}><Save size={14} /> {saved ? "Saved" : "Save instructions"}</button></div>
          </section>}
          {tab === "appearance" && <section className={styles.appearanceGrid}>
            <div className={styles.card}>
              <div className={styles.modeHeading}><div><strong>Typography</strong><span>Use a readable face for conversation and tool activity.</span></div></div>
              <div className={styles.choiceGrid}>{(["sans", "serif", "mono"] as const).map((value) => <button type="button" key={value} className={`${styles.choice} ${font === value ? styles.choiceActive : ""}`} onClick={() => setFont(value)}><span className={`${styles.typeSample} ${styles[`font_${value}`]}`}>Aa</span><span>{value === "sans" ? "DM Sans" : value === "serif" ? "Source Serif" : "JetBrains Mono"}</span>{font === value && <Check size={13} />}</button>)}</div>
              <div className={styles.previewText} style={{ fontFamily: font === "mono" ? "monospace" : font === "serif" ? "Georgia, serif" : "inherit" }}>Hi! How can I help you today?</div>
            </div>
            <div className={styles.card}>
              <div className={styles.modeHeading}><div><strong>Color accents</strong><span>Keep the interface calm; these values are stored in settings.</span></div></div>
              <label className={styles.colorField}><span>Accent</span><span><input type="color" value={accent} onChange={(event) => setAccent(event.target.value)} /><code>{accent}</code></span></label>
              <label className={styles.colorField}><span>Panel surface</span><span><input type="color" value={surface} onChange={(event) => setSurface(event.target.value)} /><code>{surface}</code></span></label>
              <div className={styles.colorPreview} style={{ background: surface, borderColor: accent }}><span style={{ background: accent }} /> Calm, visible progress inside the chat.</div>
              <div className={styles.actionRow}><span className={styles.note}>The default theme remains available in Settings.</span><button type="button" className={styles.primaryButton} onClick={saveAppearance}><Save size={14} /> {saved ? "Saved" : "Save appearance"}</button></div>
            </div>
          </section>}
          {tab === "skills" && <section className={styles.card}><div className={styles.listHeader}><div><strong>Available skills</strong><span>Skills are mode-filtered by the agent before invocation.</span></div><span className={styles.count}>{skills.length} total</span></div><div className={styles.extensionList}>{skills.map((skill) => <div className={styles.extensionRow} key={skill.id}><div className={styles.extensionIcon}><Sparkles size={14} /></div><div className={styles.extensionCopy}><strong>{skill.name}</strong><span>{skill.description}</span><small>{skill.source} · {skill.modes.join(" + ")}</small></div><Toggle checked={skill.enabled} label={`Enable ${skill.name}`} onChange={(value) => onToggleSkill(skill.id, value)} /></div>)}</div>{skills.length === 0 && <Empty icon={<Sparkles size={20} />} text="No skills installed yet." />}</section>}
          {tab === "mcp" && <section className={styles.card}><div className={styles.listHeader}><div><strong>Connected MCP servers</strong><span>Only enabled servers contribute tools to a turn.</span></div><button type="button" className={styles.secondaryButton} onClick={onAddConnector}><Plus size={14} /> Add server</button></div><div className={styles.extensionList}>{connectors.map((server) => <div className={styles.extensionRow} key={server.id}><div className={`${styles.extensionIcon} ${server.status === "connected" ? styles.iconGood : ""}`}><Plug size={14} /></div><div className={styles.extensionCopy}><strong>{server.name}</strong><span>{server.url ?? server.command ?? "Local server"}</span><small>{server.status} · {server.toolCount} tools{server.hasAuthToken ? " · token stored" : ""}</small></div><div className={styles.rowActions}><Toggle checked={server.enabled} label={`Enable ${server.name}`} onChange={(value) => onToggleConnector(server.id, value)} /><button type="button" className={styles.iconButton} onClick={() => onRemoveConnector(server.id)} aria-label={`Remove ${server.name}`}><Trash2 size={14} /></button></div></div>)}</div>{connectors.length === 0 && <Empty icon={<Plug size={20} />} text="No MCP servers connected." />}</section>}
          {tab === "plugins" && <section className={styles.card}><div className={styles.listHeader}><div><strong>Installed plugins</strong><span>Plugins stay visible when disabled so failures can be diagnosed.</span></div><button type="button" className={styles.secondaryButton} onClick={onAddPlugin}><Plus size={14} /> Install plugin</button></div><div className={styles.extensionList}>{plugins.map((plugin) => <div className={styles.extensionRow} key={plugin.id}><div className={styles.extensionIcon}><Package size={14} /></div><div className={styles.extensionCopy}><strong>{plugin.name} <small>v{plugin.version}</small></strong><span>{plugin.description || "No description provided."}</span><small>{plugin.skills.length} skills · {plugin.agents.length} agents · {plugin.commands.length} commands{plugin.error ? ` · ${plugin.error}` : ""}</small></div><div className={styles.rowActions}><Toggle checked={plugin.enabled} label={`Enable ${plugin.name}`} onChange={(value) => onTogglePlugin(plugin.id, value)} /><button type="button" className={styles.iconButton} onClick={() => onRemovePlugin(plugin.id)} aria-label={`Remove ${plugin.name}`}><Trash2 size={14} /></button></div></div>)}</div>{plugins.length === 0 && <Empty icon={<Package size={20} />} text="No plugins installed." />}</section>}
        </div>
      </main>
    </div>
  );
}

function Empty({ icon, text }: { icon: React.ReactNode; text: string }) { return <div className={styles.empty}>{icon}<span>{text}</span></div>; }
