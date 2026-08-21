import { useEffect, useRef, useState, useCallback, type KeyboardEvent } from "react";
import { File, Plug, Sparkles, Package, Play, Search } from "lucide-react";
import type { McpServerConfig, Plugin, Skill } from "@shared/types.ts";
import styles from "./AddMenu.module.css";

export type AddMenuKind = "files" | "connectors" | "skills" | "plugins";
type PanelTab = "skills" | "mcp" | "plugins";

export interface AddMenuProps {
  onPick: (kind: AddMenuKind) => void;
  onClose: () => void;
  triggerRef?: React.RefObject<HTMLElement | null>;
  skills?: Skill[];
  connectors?: McpServerConfig[];
  plugins?: Plugin[];
  onToggleSkill?: (id: string, enabled: boolean) => void;
  onToggleConnector?: (id: string, enabled: boolean) => void;
  onTogglePlugin?: (id: string, enabled: boolean) => void;
  onInvoke?: (command: string) => void;
  query?: string;
}

function Toggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: () => void }) {
  return <button type="button" className={`${styles.toggle} ${checked ? styles.toggleOn : ""}`} aria-label={label} aria-pressed={checked} onClick={(event) => { event.stopPropagation(); onChange(); }}><span /></button>;
}

export function AddMenu({ onPick, onClose, triggerRef, skills = [], connectors = [], plugins = [], onToggleSkill, onToggleConnector, onTogglePlugin, onInvoke, query = "" }: AddMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const firstItemRef = useRef<HTMLButtonElement | null>(null);
  const [tab, setTab] = useState<PanelTab>("skills");
  const isCommandSearch = query.startsWith("/") || query.startsWith("@");
  const commandQuery = query.slice(1).trim().toLowerCase();

  useEffect(() => {
    firstItemRef.current?.focus();
  }, []);

  const handleMouseDown = useCallback((event: MouseEvent) => {
    if (menuRef.current && !menuRef.current.contains(event.target as Node)) onClose();
  }, [onClose]);

  useEffect(() => {
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [handleMouseDown]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      triggerRef?.current?.focus();
      return;
    }
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[data-menu-item]") ?? []);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (!items.length) return;
    if (event.key === "ArrowDown") { event.preventDefault(); items[(index + 1 + items.length) % items.length]?.focus(); }
    if (event.key === "ArrowUp") { event.preventDefault(); items[(index - 1 + items.length) % items.length]?.focus(); }
  }

  function invoke(command: string) {
    if (onInvoke) onInvoke(command);
    else onPick(command.startsWith("@") ? "connectors" : "skills");
    onClose();
  }

  const filteredSkills = skills.filter((skill) => !commandQuery || `${skill.name} ${skill.id} ${skill.description}`.toLowerCase().includes(commandQuery));
  const filteredConnectors = connectors.filter((server) => !commandQuery || `${server.name} ${server.id}`.toLowerCase().includes(commandQuery));
  const filteredPlugins = plugins.filter((plugin) => !commandQuery || `${plugin.name} ${plugin.id} ${plugin.commands.join(" ")}`.toLowerCase().includes(commandQuery));

  const renderSkill = (skill: Skill, index: number) => (
    <div className={styles.extensionRow} key={skill.id}>
      <span className={styles.itemIcon}><Sparkles size={15} /></span>
      <span className={styles.itemCopy}><strong>{skill.name}</strong><small>{skill.description || skill.id}</small></span>
      <Toggle checked={skill.enabled} label={`Enable ${skill.name}`} onChange={() => onToggleSkill?.(skill.id, !skill.enabled)} />
      <button type="button" className={styles.invokeButton} data-menu-item ref={index === 0 ? firstItemRef : undefined} onClick={() => invoke(`/skill ${skill.id}`)}><Play size={12} /> Use</button>
    </div>
  );

  const renderConnector = (server: McpServerConfig, index: number) => (
    <div className={styles.extensionRow} key={server.id}>
      <span className={`${styles.itemIcon} ${server.status === "connected" ? styles.itemGood : ""}`}><Plug size={15} /></span>
      <span className={styles.itemCopy}><strong>{server.name}</strong><small>{server.status} · {server.toolCount} tools</small></span>
      <Toggle checked={server.enabled} label={`Enable ${server.name}`} onChange={() => onToggleConnector?.(server.id, !server.enabled)} />
      <button type="button" className={styles.invokeButton} data-menu-item ref={index === 0 ? firstItemRef : undefined} onClick={() => invoke(`@${server.name}`)}><Play size={12} /> Use</button>
    </div>
  );

  const renderPlugin = (plugin: Plugin, index: number) => (
    <div className={styles.extensionRow} key={plugin.id}>
      <span className={styles.itemIcon}><Package size={15} /></span>
      <span className={styles.itemCopy}><strong>{plugin.name}</strong><small>{plugin.description || `${plugin.commands.length} commands`}</small></span>
      <Toggle checked={plugin.enabled} label={`Enable ${plugin.name}`} onChange={() => onTogglePlugin?.(plugin.id, !plugin.enabled)} />
      <button type="button" className={styles.invokeButton} data-menu-item ref={index === 0 ? firstItemRef : undefined} onClick={() => invoke(`/plugin ${plugin.name}`)}><Play size={12} /> Use</button>
    </div>
  );

  return (
    <div ref={menuRef} className={styles.menu} role="dialog" aria-label="Quick add panel" onKeyDown={handleKeyDown}>
      <div className={styles.panelHeader}><div><strong>{isCommandSearch ? "Commands" : "Quick add"}</strong><span>{isCommandSearch ? "Choose an extension to invoke in this chat." : "Enable extensions or invoke them without leaving the conversation."}</span></div><button type="button" className={styles.fileAction} data-menu-item onClick={() => { onPick("files"); onClose(); }}><File size={14} /> Files</button></div>
      {!isCommandSearch && <div className={styles.tabs} role="tablist" aria-label="Extension types">
        <button type="button" role="tab" aria-selected={tab === "skills"} className={tab === "skills" ? styles.tabActive : styles.tab} onClick={() => setTab("skills")}><Sparkles size={13} /> Skills <em>{skills.length}</em></button>
        <button type="button" role="tab" aria-selected={tab === "mcp"} className={tab === "mcp" ? styles.tabActive : styles.tab} onClick={() => setTab("mcp")}><Plug size={13} /> MCP <em>{connectors.length}</em></button>
        <button type="button" role="tab" aria-selected={tab === "plugins"} className={tab === "plugins" ? styles.tabActive : styles.tab} onClick={() => setTab("plugins")}><Package size={13} /> Plugins <em>{plugins.length}</em></button>
      </div>}
      {isCommandSearch && <div className={styles.commandHint}><Search size={13} /> {query.startsWith("/") ? "Slash commands: /skill or /plugin" : "Mentions: @MCP server"}</div>}
      <div className={styles.list}>
        {isCommandSearch && query.startsWith("/") && filteredSkills.map(renderSkill)}
        {isCommandSearch && query.startsWith("/") && filteredPlugins.map(renderPlugin)}
        {isCommandSearch && query.startsWith("@") && filteredConnectors.map(renderConnector)}
        {!isCommandSearch && tab === "skills" && skills.map(renderSkill)}
        {!isCommandSearch && tab === "mcp" && connectors.map(renderConnector)}
        {!isCommandSearch && tab === "plugins" && plugins.map(renderPlugin)}
        {((isCommandSearch && !filteredSkills.length && !filteredConnectors.length && !filteredPlugins.length) || (!isCommandSearch && !skills.length && tab === "skills") || (!isCommandSearch && !connectors.length && tab === "mcp") || (!isCommandSearch && !plugins.length && tab === "plugins")) && <div className={styles.empty}>No matching extensions.</div>}
      </div>
      <div className={styles.panelFooter}><span>Type <kbd>/</kbd> for skills and plugins, or <kbd>@</kbd> for MCP.</span><button type="button" className={styles.closeLink} onClick={onClose}>Close</button></div>
    </div>
  );
}

export default AddMenu;
