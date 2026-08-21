import { useState, type ReactNode } from "react";
import { ArrowLeft, Code2, Package, Plug, Plus, Sparkles, Trash2 } from "lucide-react";
import type { McpServerConfig, Mode, Plugin, Skill } from "@shared/types.ts";
import styles from "./CustomizePage.module.css";
import logoUrl from "../assets/kozum-logo.png";

export interface CustomizePageProps {
  skills: Skill[];
  connectors: McpServerConfig[];
  plugins: Plugin[];
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

export type CustomizeTab = "skills" | "mcp" | "plugins";

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
  onAddPlugin,
  onBack,
  initialTab = "mcp",
}: CustomizePageProps) {
  const [tab, setTab] = useState<CustomizeTab>(initialTab);
  const [mode, setMode] = useState<Mode>("cowork");
  const enabledSkills = skills.filter((skill) => skill.enabled).length;
  const enabledConnectors = connectors.filter((server) => server.enabled).length;
  const enabledPlugins = plugins.filter((plugin) => plugin.enabled).length;

  return (
    <div className={styles.page}>
      <aside className={styles.sidebar}>
        <button type="button" className={styles.backButton} onClick={onBack}>
          <ArrowLeft size={15} /> Back to workspace
        </button>
        <div className={styles.brand}>
          <img src={logoUrl} alt="Kozum AI" />
          <div><strong>Kozum AI</strong><span>Customize</span></div>
        </div>
        <div className={styles.modeSwitch}>
          <span className={styles.modeTitle}>Active surface</span>
          <div className={styles.modeRow}>
            <ModePill mode="cowork" active={mode === "cowork"} onClick={() => setMode("cowork")} />
            <ModePill mode="code" active={mode === "code"} onClick={() => setMode("code")} />
          </div>
        </div>
        <nav className={styles.nav} aria-label="Customize sections">
          <div className={styles.navLabel}>Extensions</div>
          <button type="button" className={`${styles.navItem} ${tab === "skills" ? styles.navActive : ""}`} onClick={() => setTab("skills")}>
            <Sparkles size={15} /><span>Skills <em>{enabledSkills}</em></span>
          </button>
          <button type="button" className={`${styles.navItem} ${tab === "mcp" ? styles.navActive : ""}`} onClick={() => setTab("mcp")}>
            <Plug size={15} /><span>MCP servers <em>{enabledConnectors}</em></span>
          </button>
          <button type="button" className={`${styles.navItem} ${tab === "plugins" ? styles.navActive : ""}`} onClick={() => setTab("plugins")}>
            <Package size={15} /><span>Plugins <em>{enabledPlugins}</em></span>
          </button>
        </nav>
        <div className={styles.sidebarFooter}>Skills and plugins remain optional; install or enable only what you need <span /></div>
      </aside>

      <main className={styles.main}>
        <div className={styles.topBar}>
          <span className={styles.breadcrumb}>Customize <span>/</span> {tab === "mcp" ? "MCP servers" : tab[0].toUpperCase() + tab.slice(1)}</span>
          <button type="button" className={styles.closeButton} onClick={onBack}>Done</button>
        </div>
        <div className={styles.content}>
          <Header tab={tab} />

          {tab === "skills" && (
            <section className={styles.card}>
              <div className={styles.listHeader}>
                <div><strong>Available skills</strong><span>Skills are mode-filtered by the agent before invocation.</span></div>
                <span className={styles.count}>{skills.length} total</span>
              </div>
              <div className={styles.extensionList}>
                {skills.map((skill) => (
                  <div className={styles.extensionRow} key={skill.id}>
                    <div className={styles.extensionIcon}><Sparkles size={14} /></div>
                    <div className={styles.extensionCopy}><strong>{skill.name}</strong><span>{skill.description}</span><small>{skill.source} · {skill.modes.join(" + ")}</small></div>
                    <Toggle checked={skill.enabled} label={`Enable ${skill.name}`} onChange={(value) => onToggleSkill(skill.id, value)} />
                  </div>
                ))}
              </div>
              {skills.length === 0 && <Empty icon={<Sparkles size={20} />} text="No skills installed yet. Add a skill from the chat add panel." />}
            </section>
          )}

          {tab === "mcp" && (
            <section className={styles.card}>
              <div className={styles.listHeader}>
                <div><strong>Connected MCP servers</strong><span>Only enabled servers contribute tools to a turn.</span></div>
                <button type="button" className={styles.secondaryButton} onClick={onAddConnector}><Plus size={14} /> Add server</button>
              </div>
              <div className={styles.extensionList}>
                {connectors.map((server) => (
                  <div className={styles.extensionRow} key={server.id}>
                    <div className={`${styles.extensionIcon} ${server.status === "connected" ? styles.iconGood : ""}`}><Plug size={14} /></div>
                    <div className={styles.extensionCopy}><strong>{server.name}</strong><span>{server.url ?? server.command ?? "Local server"}</span><small>{server.status} · {server.toolCount} tools{server.hasAuthToken ? " · token stored" : ""}</small></div>
                    <div className={styles.rowActions}>
                      <Toggle checked={server.enabled} label={`Enable ${server.name}`} onChange={(value) => onToggleConnector(server.id, value)} />
                      <button type="button" className={styles.iconButton} onClick={() => onRemoveConnector(server.id)} aria-label={`Remove ${server.name}`}><Trash2 size={14} /></button>
                    </div>
                  </div>
                ))}
              </div>
              {connectors.length === 0 && <Empty icon={<Plug size={20} />} text="No MCP servers connected." />}
            </section>
          )}

          {tab === "plugins" && (
            <section className={styles.card}>
              <div className={styles.listHeader}>
                <div><strong>Installed plugins</strong><span>Plugins remain visible when disabled so failures can be diagnosed.</span></div>
                <button type="button" className={styles.secondaryButton} onClick={onAddPlugin}><Plus size={14} /> Install plugin</button>
              </div>
              <div className={styles.extensionList}>
                {plugins.map((plugin) => (
                  <div className={styles.extensionRow} key={plugin.id}>
                    <div className={styles.extensionIcon}><Package size={14} /></div>
                    <div className={styles.extensionCopy}><strong>{plugin.name} <small>v{plugin.version}</small></strong><span>{plugin.description || "No description provided."}</span><small>{plugin.skills.length} skills · {plugin.agents.length} agents · {plugin.commands.length} commands{plugin.error ? ` · ${plugin.error}` : ""}</small></div>
                    <div className={styles.rowActions}>
                      <Toggle checked={plugin.enabled} label={`Enable ${plugin.name}`} onChange={(value) => onTogglePlugin(plugin.id, value)} />
                      <button type="button" className={styles.iconButton} onClick={() => onRemovePlugin(plugin.id)} aria-label={`Remove ${plugin.name}`}><Trash2 size={14} /></button>
                    </div>
                  </div>
                ))}
              </div>
              {plugins.length === 0 && <Empty icon={<Package size={20} />} text="No plugins installed yet. Install one from the chat add panel." />}
            </section>
          )}
        </div>
      </main>
    </div>
  );
}

export default CustomizePage;
