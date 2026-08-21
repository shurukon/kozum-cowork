import { useState } from "react";
import { ArrowLeft, Code2, Plug, Plus, Trash2, Sparkles } from "lucide-react";
import type { McpServerConfig, Mode } from "@shared/types.ts";
import styles from "./CustomizePage.module.css";
import logoUrl from "../assets/kozum-logo.png";

export interface CustomizePageProps {
  connectors: McpServerConfig[];
  onToggleConnector: (id: string, enabled: boolean) => void;
  onRemoveConnector: (id: string) => void;
  onAddConnector: () => void;
  onBack: () => void;
  initialTab?: CustomizeTab;
}

export type CustomizeTab = "mcp";

function Toggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: (value: boolean) => void }) {
  return <button type="button" className={`${styles.toggle} ${checked ? styles.toggleOn : ""}`} aria-label={label} aria-pressed={checked} onClick={() => onChange(!checked)}><span /></button>;
}

function ModePill({ mode, active, onClick }: { mode: Mode; active: boolean; onClick: () => void }) {
  return <button type="button" className={`${styles.modePill} ${active ? styles.modePillActive : ""}`} onClick={onClick}>{mode === "cowork" ? <Sparkles size={13} /> : <Code2 size={13} />}{mode === "cowork" ? "Cowork" : "Code"}</button>;
}

export function CustomizePage({ connectors, onToggleConnector, onRemoveConnector, onAddConnector, onBack }: CustomizePageProps) {
  const [mode, setMode] = useState<Mode>("cowork");
  const enabledConnectors = connectors.filter((server) => server.enabled).length;

  return (
    <div className={styles.page}>
      <aside className={styles.sidebar}>
        <button type="button" className={styles.backButton} onClick={onBack}><ArrowLeft size={15} /> Back to workspace</button>
        <div className={styles.brand}><img src={logoUrl} alt="Kozum AI" /><div><strong>Kozum AI</strong><span>Customize</span></div></div>
        <div className={styles.modeSwitch}><span className={styles.modeTitle}>Active surface</span><div className={styles.modeRow}><ModePill mode="cowork" active={mode === "cowork"} onClick={() => setMode("cowork")} /><ModePill mode="code" active={mode === "code"} onClick={() => setMode("code")} /></div></div>
        <nav className={styles.nav} aria-label="Customize sections">
          <div className={styles.navLabel}>Extensions</div>
          <button type="button" className={`${styles.navItem} ${styles.navActive}`}><Plug size={15} /><span>MCP servers <em>{enabledConnectors}</em></span></button>
        </nav>
        <div className={styles.sidebarFooter}>Manage MCP here; skills and plugins are available from the chat add panel <span /></div>
      </aside>
      <main className={styles.main}>
        <div className={styles.topBar}><span className={styles.breadcrumb}>Customize <span>/</span> MCP servers</span><button type="button" className={styles.closeButton} onClick={onBack}>Done</button></div>
        <div className={styles.content}>
          <header className={styles.header}><span className={styles.eyebrow}>Extensions</span><h1>MCP servers</h1><p>Connect external tool servers with explicit enablement and visible status.</p></header>
          <section className={styles.card}>
            <div className={styles.listHeader}><div><strong>Connected MCP servers</strong><span>Only enabled servers contribute tools to a turn.</span></div><button type="button" className={styles.secondaryButton} onClick={onAddConnector}><Plus size={14} /> Add server</button></div>
            <div className={styles.extensionList}>
              {connectors.map((server) => <div className={styles.extensionRow} key={server.id}>
                <div className={`${styles.extensionIcon} ${server.status === "connected" ? styles.iconGood : ""}`}><Plug size={14} /></div>
                <div className={styles.extensionCopy}><strong>{server.name}</strong><span>{server.url ?? server.command ?? "Local server"}</span><small>{server.status} · {server.toolCount} tools{server.hasAuthToken ? " · token stored" : ""}</small></div>
                <div className={styles.rowActions}><Toggle checked={server.enabled} label={`Enable ${server.name}`} onChange={(value) => onToggleConnector(server.id, value)} /><button type="button" className={styles.iconButton} onClick={() => onRemoveConnector(server.id)} aria-label={`Remove ${server.name}`}><Trash2 size={14} /></button></div>
              </div>)}
            </div>
            {connectors.length === 0 && <div className={styles.empty}><Plug size={20} /><span>No MCP servers connected.</span></div>}
          </section>
        </div>
      </main>
    </div>
  );
}

export default CustomizePage;
