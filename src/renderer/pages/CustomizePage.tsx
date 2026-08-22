import { useState, type ReactNode } from "react";
import { AlertCircle, ArrowLeft, Check, Code2, FileArchive, Github, Loader2, Package, Plug, Plus, Sparkles, Trash2 } from "lucide-react";
import type { McpServerConfig, Mode, Plugin, Result, Skill } from "@shared/types.ts";
import styles from "./CustomizePage.module.css";
import logoUrl from "../assets/kozum-logo.png";

export type CustomizeTab = "skills" | "mcp" | "plugins";

export type McpAddInput = Omit<McpServerConfig, "id" | "createdAt" | "status" | "toolCount"> & {
  authToken?: string;
};

export type PluginInstallSource = { kind: "zip" | "github"; value: string };

export interface CustomizePageProps {
  skills: Skill[];
  connectors: McpServerConfig[];
  plugins: Plugin[];
  onToggleSkill: (id: string, enabled: boolean) => void;
  onToggleConnector: (id: string, enabled: boolean) => void;
  onTogglePlugin: (id: string, enabled: boolean) => void;
  onRemoveConnector: (id: string) => void | Promise<void>;
  onRemovePlugin: (id: string) => void | Promise<void>;
  onAddConnector: (input: McpAddInput) => Promise<Result<McpServerConfig>>;
  onTestConnector: (input: McpAddInput) => Promise<Result<{ transport: McpServerConfig["transport"]; toolCount: number; toolNames: string[] }>>;
  onInstallPlugin: (source: PluginInstallSource) => Promise<Result<Plugin>>;
  onPickPluginZip: () => Promise<string | null>;
  onBack: () => void;
  initialTab?: CustomizeTab;
}

type ToggleProps = {
  checked: boolean;
  label: string;
  onChange: (value: boolean) => void;
};

function Toggle({ checked, label, onChange }: ToggleProps) {
  return (
    <button
      type="button"
      className={`${styles.toggle} ${checked ? styles.toggleOn : ""}`}
      aria-label={label}
      aria-pressed={checked}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

function ModePill({ mode, active, onClick }: { mode: Mode; active: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`${styles.modePill} ${active ? styles.modePillActive : ""}`} onClick={onClick}>
      {mode === "cowork" ? <Sparkles size={13} /> : <Code2 size={13} />}
      {mode === "cowork" ? "Cowork" : "Code"}
    </button>
  );
}

function Header({ tab }: { tab: CustomizeTab }) {
  const labels: Record<CustomizeTab, [string, string, string]> = {
    skills: ["Extensions", "Skills", "Enable the skills that should be available to the current agent modes."],
    mcp: ["Extensions", "MCP servers", "Connect external tool servers with explicit enablement and visible status."],
    plugins: ["Extensions", "Plugins", "Review installed plugins and the skills, agents, commands, and servers they contribute."],
  };
  const [eyebrow, title, description] = labels[tab];
  return (
    <header className={styles.header}>
      <span className={styles.eyebrow}>{eyebrow}</span>
      <h1>{title}</h1>
      <p>{description}</p>
    </header>
  );
}

function Empty({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className={styles.empty}>
      {icon}
      <span>{text}</span>
    </div>
  );
}

function InlineNotice({ kind, children }: { kind: "success" | "error" | "info"; children: ReactNode }) {
  return <div className={`${styles.inlineNotice} ${styles[`inlineNotice${kind[0].toUpperCase()}${kind.slice(1)}`]}`} role={kind === "error" ? "alert" : undefined}>{children}</div>;
}

function McpForm({ onSubmit, onTest, onClose }: { onSubmit: CustomizePageProps["onAddConnector"]; onTest: CustomizePageProps["onTestConnector"]; onClose: () => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [headerName, setHeaderName] = useState("Authorization");
  const [allowLocal, setAllowLocal] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState<McpServerConfig | null>(null);

  function validateUrl(raw: string): string | null {
    if (!raw.trim()) return "Server URL is required.";
    try {
      const parsed = new URL(raw.trim());
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "URL must use http or https.";
      return null;
    } catch {
      return "That doesn't look like a valid URL.";
    }
  }

  function deriveName(raw: string): string {
    try {
      return new URL(raw).hostname;
    } catch {
      return raw.split("/").filter(Boolean).pop() ?? "MCP server";
    }
  }

  function buildInput(): McpAddInput {
    return {
      name: name.trim() || deriveName(url.trim()),
      enabled: true,
      transport: "http",
      url: url.trim(),
      hasAuthToken: Boolean(token.trim()),
      authToken: token.trim() || undefined,
      authHeader: headerName.trim() || "Authorization",
      allowLocal,
      installedByAgent: false,
    };
  }

  async function handleTest() {
    setError(null);
    setTestMessage(null);
    const urlError = validateUrl(url);
    if (urlError) {
      setError(urlError);
      setTestMessage(urlError);
      return;
    }
    setBusy(true);
    try {
      const result = await onTest(buildInput());
      if (!result.ok) {
        setError(result.error);
        setTestMessage(result.error);
        return;
      }
      setTestMessage(`Handshake succeeded · ${result.value.toolCount} tool${result.value.toolCount === 1 ? "" : "s"} discovered.`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      setTestMessage(message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmit() {
    setError(null);
    const urlError = validateUrl(url);
    if (urlError) {
      setError(urlError);
      return;
    }
    setBusy(true);
    try {
      const result = await onSubmit(buildInput());
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setConnected(result.value);
      setName("");
      setUrl("");
      setToken("");
      setTestMessage(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.inlineForm} aria-label="Add MCP server form">
      <div className={styles.inlineFormHeader}>
        <div><strong>Add an MCP server</strong><span>Connect a remote HTTP MCP server directly from Customize.</span></div>
        <button type="button" className={styles.textButton} onClick={onClose} disabled={busy}>Close</button>
      </div>
      <div className={styles.formGrid}>
        <label className={styles.formField}><span>Name</span><input value={name} placeholder="Auto-detected from URL" onChange={(event) => setName(event.target.value)} disabled={busy} /></label>
        <label className={styles.formField}><span>Server URL <b>*</b></span><input type="url" value={url} placeholder="https://example.com/mcp" onChange={(event) => { setUrl(event.target.value); setError(null); setConnected(null); setTestMessage(null); }} disabled={busy} /></label>
        <label className={styles.formField}><span>Auth token <small>(optional)</small></span><input type="password" value={token} placeholder="sk-…" onChange={(event) => setToken(event.target.value)} disabled={busy} /><em>Stored encrypted by the OS keychain.</em></label>
      </div>
      <button type="button" className={styles.advancedButton} onClick={() => setAdvancedOpen((value) => !value)} aria-expanded={advancedOpen}>{advancedOpen ? "Hide" : "Show"} advanced settings</button>
      {advancedOpen && <>
        <label className={styles.formField}><span>Auth header name</span><input value={headerName} placeholder="Authorization" onChange={(event) => setHeaderName(event.target.value)} disabled={busy} /><em>Most servers use Authorization.</em></label>
        <label className={styles.formField}><span>Local server access</span><span><input type="checkbox" checked={allowLocal} onChange={(event) => setAllowLocal(event.target.checked)} disabled={busy} /> Allow localhost / 127.0.0.1</span><em>Enable only for a server you control on this computer.</em></label>
      </>}
      <div className={styles.inlineFormActions}>
        <button type="button" className={styles.secondaryButton} disabled={busy || !url.trim()} onClick={() => void handleTest()}>Test connection</button>
        <button type="button" className={styles.primaryButton} disabled={busy || !url.trim()} onClick={() => void handleSubmit()}>{busy ? <Loader2 size={14} className="kz-spin" /> : "Connect server"}</button>
      </div>
      {testMessage && <InlineNotice kind={error ? "error" : "info"}>{error ? <><AlertCircle size={14} />{testMessage}</> : <>{testMessage}</>}</InlineNotice>}
      {connected && <InlineNotice kind="success"><Check size={14} />Connected to {connected.name}{connected.toolCount > 0 ? ` with ${connected.toolCount} tools` : ""}.</InlineNotice>}
      {error && !testMessage && <InlineNotice kind="error"><AlertCircle size={14} />{error}</InlineNotice>}
    </section>
  );
}

function PluginForm({ onSubmit, onPickZip, onClose }: { onSubmit: CustomizePageProps["onInstallPlugin"]; onPickZip: CustomizePageProps["onPickPluginZip"]; onClose: () => void }) {
  const [sourceKind, setSourceKind] = useState<"zip" | "github">("zip");
  const [zipPath, setZipPath] = useState<string | null>(null);
  const [githubRef, setGithubRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installed, setInstalled] = useState<Plugin | null>(null);

  async function chooseZip() {
    const path = await onPickZip();
    if (path) {
      setZipPath(path);
      setError(null);
      setInstalled(null);
    }
  }

  async function install() {
    const value = sourceKind === "zip" ? zipPath : githubRef.trim();
    if (!value) {
      setError(sourceKind === "zip" ? "Choose a .zip file first." : "Enter a GitHub repo reference.");
      return;
    }
    setBusy(true);
    setError(null);
    setInstalled(null);
    try {
      const result = await onSubmit({ kind: sourceKind, value });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setInstalled(result.value);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const contributions = installed ? [
    installed.skills.length ? `${installed.skills.length} skill${installed.skills.length === 1 ? "" : "s"}` : "",
    installed.agents.length ? `${installed.agents.length} agent${installed.agents.length === 1 ? "" : "s"}` : "",
    installed.commands.length ? `${installed.commands.length} command${installed.commands.length === 1 ? "" : "s"}` : "",
    installed.mcpServers.length ? `${installed.mcpServers.length} MCP server${installed.mcpServers.length === 1 ? "" : "s"}` : "",
  ].filter(Boolean) : [];

  return (
    <section className={styles.inlineForm} aria-label="Install plugin form">
      <div className={styles.inlineFormHeader}>
        <div><strong>Install a plugin</strong><span>Install from a local archive or GitHub without leaving Customize.</span></div>
        <button type="button" className={styles.textButton} onClick={onClose} disabled={busy}>Close</button>
      </div>
      <div className={styles.formTabs} role="tablist" aria-label="Plugin source">
        <button type="button" role="tab" aria-selected={sourceKind === "zip"} className={`${styles.formTab} ${sourceKind === "zip" ? styles.formTabActive : ""}`} onClick={() => { setSourceKind("zip"); setError(null); setInstalled(null); }} disabled={busy}><FileArchive size={13} /> From .zip file</button>
        <button type="button" role="tab" aria-selected={sourceKind === "github"} className={`${styles.formTab} ${sourceKind === "github" ? styles.formTabActive : ""}`} onClick={() => { setSourceKind("github"); setError(null); setInstalled(null); }} disabled={busy}><Github size={13} /> From GitHub</button>
      </div>
      {sourceKind === "zip" ? (
        <button type="button" className={styles.fileChoice} onClick={() => void chooseZip()} disabled={busy}><Package size={16} /><span>{zipPath ?? "Choose a .zip file…"}</span></button>
      ) : (
        <label className={styles.formField}><span>GitHub reference</span><input value={githubRef} placeholder="owner/repo or https://github.com/owner/repo" onChange={(event) => { setGithubRef(event.target.value); setError(null); setInstalled(null); }} disabled={busy} /><em>Accepted: owner/repo, owner/repo@ref, or a full GitHub URL.</em></label>
      )}
      <div className={styles.inlineFormActions}><button type="button" className={styles.primaryButton} disabled={busy || !(sourceKind === "zip" ? zipPath : githubRef.trim())} onClick={() => void install()}>{busy ? <><Loader2 size={14} className="kz-spin" /> Installing…</> : "Install plugin"}</button></div>
      {error && <InlineNotice kind="error"><AlertCircle size={14} />{error}</InlineNotice>}
      {installed && <InlineNotice kind="success"><Check size={14} /><span><strong>{installed.name}</strong> installed successfully{contributions.length ? ` · ${contributions.join(" · ")}` : ""}.</span></InlineNotice>}
    </section>
  );
}

export function CustomizePage({
  skills,
  connectors,
  plugins,
  onToggleSkill,
  onToggleConnector,
  onTogglePlugin,
  onRemoveConnector,
  onRemovePlugin,
  onAddConnector,
  onTestConnector,
  onInstallPlugin,
  onPickPluginZip,
  onBack,
  initialTab = "mcp",
}: CustomizePageProps) {
  const [tab, setTab] = useState<CustomizeTab>(initialTab);
  const [mode, setMode] = useState<Mode>("cowork");
  const [mcpFormOpen, setMcpFormOpen] = useState(false);
  const [pluginFormOpen, setPluginFormOpen] = useState(false);
  const enabledSkills = skills.filter((skill) => skill.enabled).length;
  const enabledConnectors = connectors.filter((server) => server.enabled).length;
  const enabledPlugins = plugins.filter((plugin) => plugin.enabled).length;

  return (
    <div className={styles.page}>
      <aside className={styles.sidebar}>
        <button type="button" className={styles.backButton} onClick={onBack}><ArrowLeft size={15} /> Back to workspace</button>
        <div className={styles.brand}><img src={logoUrl} alt="Kozum AI" /><div><strong>Kozum AI</strong><span>Customize</span></div></div>
        <div className={styles.modeSwitch}><span className={styles.modeTitle}>Active surface</span><div className={styles.modeRow}><ModePill mode="cowork" active={mode === "cowork"} onClick={() => setMode("cowork")} /><ModePill mode="code" active={mode === "code"} onClick={() => setMode("code")} /></div></div>
        <nav className={styles.nav} aria-label="Customize sections">
          <div className={styles.navLabel}>Extensions</div>
          <button type="button" className={`${styles.navItem} ${tab === "skills" ? styles.navActive : ""}`} onClick={() => setTab("skills")}><Sparkles size={15} /><span>Skills <em>{enabledSkills}</em></span></button>
          <button type="button" className={`${styles.navItem} ${tab === "mcp" ? styles.navActive : ""}`} onClick={() => setTab("mcp")}><Plug size={15} /><span>MCP servers <em>{enabledConnectors}</em></span></button>
          <button type="button" className={`${styles.navItem} ${tab === "plugins" ? styles.navActive : ""}`} onClick={() => setTab("plugins")}><Package size={15} /><span>Plugins <em>{enabledPlugins}</em></span></button>
        </nav>
        <div className={styles.sidebarFooter}>Skills and plugins remain optional; install or enable only what you need <span /></div>
      </aside>

      <main className={styles.main}>
        <div className={styles.topBar}><span className={styles.breadcrumb}>Customize <span>/</span> {tab === "mcp" ? "MCP servers" : tab[0].toUpperCase() + tab.slice(1)}</span><button type="button" className={styles.closeButton} onClick={onBack}>Done</button></div>
        <div className={styles.content}>
          <Header tab={tab} />

          {tab === "skills" && <section className={styles.card}><div className={styles.listHeader}><div><strong>Available skills</strong><span>Skills are mode-filtered by the agent before invocation.</span></div><span className={styles.count}>{skills.length} total</span></div><div className={styles.extensionList}>{skills.map((skill) => <div className={styles.extensionRow} key={skill.id}><div className={styles.extensionIcon}><Sparkles size={14} /></div><div className={styles.extensionCopy}><strong>{skill.name}</strong><span>{skill.description}</span><small>{skill.source} · {skill.modes.join(" + ")}</small></div><Toggle checked={skill.enabled} label={`Enable ${skill.name}`} onChange={(value) => onToggleSkill(skill.id, value)} /></div>)}</div>{skills.length === 0 && <Empty icon={<Sparkles size={20} />} text="No skills installed yet. Install a plugin or add a skill from the chat add panel." />}</section>}

          {tab === "mcp" && <>
            {mcpFormOpen && <McpForm onSubmit={onAddConnector} onTest={onTestConnector} onClose={() => setMcpFormOpen(false)} />}
            <section className={styles.card}><div className={styles.listHeader}><div><strong>Connected MCP servers</strong><span>Only enabled servers contribute tools to a turn.</span></div><button type="button" className={styles.secondaryButton} onClick={() => setMcpFormOpen((value) => !value)} aria-expanded={mcpFormOpen}><Plus size={14} /> {mcpFormOpen ? "Hide form" : "Add server"}</button></div><div className={styles.extensionList}>{connectors.map((server) => <div className={styles.extensionRow} key={server.id}><div className={`${styles.extensionIcon} ${server.status === "connected" ? styles.iconGood : ""}`}><Plug size={14} /></div><div className={styles.extensionCopy}><strong>{server.name}</strong><span>{server.url ?? server.command ?? "Local server"}</span><small>{server.status} · {server.toolCount} tools{server.hasAuthToken ? " · token stored" : ""}</small></div><div className={styles.rowActions}><Toggle checked={server.enabled} label={`Enable ${server.name}`} onChange={(value) => onToggleConnector(server.id, value)} /><button type="button" className={styles.iconButton} onClick={() => void onRemoveConnector(server.id)} aria-label={`Remove ${server.name}`}><Trash2 size={14} /></button></div></div>)}</div>{connectors.length === 0 && <Empty icon={<Plug size={20} />} text={mcpFormOpen ? "Add your first MCP server above." : "No MCP servers connected yet. Add one here."} />}</section>
          </>}

          {tab === "plugins" && <>
            {pluginFormOpen && <PluginForm onSubmit={onInstallPlugin} onPickZip={onPickPluginZip} onClose={() => setPluginFormOpen(false)} />}
            <section className={styles.card}><div className={styles.listHeader}><div><strong>Installed plugins</strong><span>Plugins remain visible when disabled so failures can be diagnosed.</span></div><button type="button" className={styles.secondaryButton} onClick={() => setPluginFormOpen((value) => !value)} aria-expanded={pluginFormOpen}><Plus size={14} /> {pluginFormOpen ? "Hide form" : "Install plugin"}</button></div><div className={styles.extensionList}>{plugins.map((plugin) => <div className={styles.extensionRow} key={plugin.id}><div className={styles.extensionIcon}><Package size={14} /></div><div className={styles.extensionCopy}><strong>{plugin.name} <small>v{plugin.version}</small></strong><span>{plugin.description || "No description provided."}</span><small>{plugin.skills.length} skills · {plugin.agents.length} agents · {plugin.commands.length} commands{plugin.error ? ` · ${plugin.error}` : ""}</small></div><div className={styles.rowActions}><Toggle checked={plugin.enabled} label={`Enable ${plugin.name}`} onChange={(value) => onTogglePlugin(plugin.id, value)} /><button type="button" className={styles.iconButton} onClick={() => void onRemovePlugin(plugin.id)} aria-label={`Remove ${plugin.name}`}><Trash2 size={14} /></button></div></div>)}</div>{plugins.length === 0 && <Empty icon={<Package size={20} />} text={pluginFormOpen ? "Install your first plugin above." : "No plugins installed yet. Install one here."} />}</section>
          </>}
        </div>
      </main>
    </div>
  );
}

export default CustomizePage;
