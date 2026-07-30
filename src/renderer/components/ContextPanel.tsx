/**
 * Kozum Cowork — ContextPanel component.
 *
 * Shows:
 *   • MCP servers (name + connection dot + tool count)
 *   • Tools used this session (icons from toolIcons.ts)
 *   • Enabled plugins
 *   • Working folder chip (clickable → onOpenPath)
 *   • Shared files (chips, clickable → onOpenPath)
 */

import { FolderOpen, Package, Wrench } from "lucide-react";
import type { McpServerConfig } from "@shared/types.ts";
import { toolIcon } from "../lib/toolIcons.ts";
import styles from "./ContextPanel.module.css";

// ── MCP servers ───────────────────────────────────────────────────────────

interface McpRowProps {
  server: McpServerConfig;
}

function McpRow({ server }: McpRowProps) {
  const dotClass =
    server.status === "connected"
      ? styles.connDotOk
      : server.status === "error"
        ? styles.connDotErr
        : server.status === "connecting"
          ? styles.connDotConnecting
          : styles.connDotIdle;

  return (
    <li className={styles.mcpRow}>
      <span className={`${styles.connDot} ${dotClass}`} aria-hidden="true" />
      <span className={styles.mcpName} title={server.name}>
        {server.name}
      </span>
      <span className={styles.toolCount}>{server.toolCount} tools</span>
    </li>
  );
}

// ── Tool chip ─────────────────────────────────────────────────────────────

interface ToolChipProps {
  name: string;
}

function ToolChip({ name }: ToolChipProps) {
  const info = toolIcon(name);
  return (
    <li className={styles.chip} title={name}>
      <span className={styles.chipIcon} aria-hidden="true">
        {/* Icon name from toolIcons is a Lucide name; render a fallback glyph */}
        <ToolGlyph icon={info.icon} />
      </span>
      <span className={styles.chipLabel}>{info.label}</span>
    </li>
  );
}

/**
 * Lightweight inline icon using a minimal SVG so we don't import Lucide's full
 * component tree for each dynamic icon name (the name is a string, not a
 * component). We render a single wrench SVG as a universal tool glyph, with a
 * data attribute so callers can style by icon name if needed.
 */
function ToolGlyph({ icon }: { icon: string }) {
  // Map a few key icon names to inline SVG paths for visual differentiation.
  // All others fall back to a wrench shape.
  const glyphs: Record<string, string> = {
    terminal: "M4 6l2 2-2 2m4 0h4",
    globe: "M12 12c0-4.4-3.6-8-8-8m8 8H4m8 0c0 4.4-3.6 8-8 8m0-16a8 8 0 1 0 0 16A8 8 0 0 0 4 4",
    "file-text": "M4 2h8l4 4v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm7 1v4h4M7 9h6M7 12h6M7 15h4",
    "file-plus": "M4 2h8l4 4v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm7 1v4h4M9 12v4M7 14h4",
    search: "M11 11a5 5 0 1 0-7.1 0L9 15l5-5M18 18l-3-3",
    bot: "M12 2a4 4 0 0 1 4 4v1h1a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1V6a4 4 0 0 1 4-4zm-2 9a1 1 0 1 0 2 0 1 1 0 0 0-2 0zm4 0a1 1 0 1 0 2 0 1 1 0 0 0-2 0",
    plug: "M7 2v4M17 2v4M8 12v4M16 12v4M5 8a4 4 0 0 0 4 4h6a4 4 0 0 0 4-4H5z",
    monitor: "M2 4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2zm8 16h4M12 18v2",
    brain: "M9.5 2a4 4 0 0 0-4 4c0 .7.2 1.4.5 2A4 4 0 0 0 2 12c0 2 1.5 3.7 3.4 4a4 4 0 0 0 7.6 1.4A4 4 0 0 0 21 14.5a4.5 4.5 0 0 0-2-8.5 4 4 0 0 0-5.5-4z",
  };

  const d = glyphs[icon];
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      data-icon={icon}
      aria-hidden="true"
    >
      {d ? (
        <path d={d} />
      ) : (
        // Generic wrench for unrecognised icons
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
      )}
    </svg>
  );
}

// ── Path chip (folder / file) ─────────────────────────────────────────────

interface PathChipProps {
  path: string;
  icon?: typeof FolderOpen;
  onOpenPath: (path: string) => void;
}

function PathChip({ path, icon: Icon = FolderOpen, onOpenPath }: PathChipProps) {
  const label = path.split("/").pop() ?? path.split("\\").pop() ?? path;
  return (
    <li className={styles.pathChip}>
      <button
        className={styles.pathChipBtn}
        title={path}
        onClick={() => onOpenPath(path)}
        type="button"
      >
        <Icon size={11} aria-hidden="true" />
        <span className={styles.pathChipLabel}>{label}</span>
      </button>
    </li>
  );
}

// ── Subsection heading ────────────────────────────────────────────────────

function SubHeading({ children }: { children: string }) {
  return <h4 className={styles.subHeading}>{children}</h4>;
}

// ── Props ──────────────────────────────────────────────────────────────────

export interface ContextPanelProps {
  mcpServers: McpServerConfig[];
  plugins: { name: string }[];
  toolsUsed: string[];
  workingFolder: string | null;
  sharedFiles: string[];
  onOpenPath: (path: string) => void;
}

// ── Component ─────────────────────────────────────────────────────────────

export function ContextPanel({
  mcpServers,
  plugins,
  toolsUsed,
  workingFolder,
  sharedFiles,
  onOpenPath,
}: ContextPanelProps) {
  const hasContent =
    mcpServers.length > 0 ||
    toolsUsed.length > 0 ||
    plugins.length > 0 ||
    workingFolder !== null ||
    sharedFiles.length > 0;

  if (!hasContent) {
    return <p className={styles.empty}>No context active.</p>;
  }

  return (
    <div className={styles.root}>
      {/* MCP servers */}
      {mcpServers.length > 0 && (
        <div className={styles.group}>
          <SubHeading>MCP servers</SubHeading>
          <ul className={styles.mcpList}>
            {mcpServers.map((s) => (
              <McpRow key={s.id} server={s} />
            ))}
          </ul>
        </div>
      )}

      {/* Tools used */}
      {toolsUsed.length > 0 && (
        <div className={styles.group}>
          <SubHeading>Tools used</SubHeading>
          <ul className={styles.chipList}>
            {toolsUsed.map((name) => (
              <ToolChip key={name} name={name} />
            ))}
          </ul>
        </div>
      )}

      {/* Plugins */}
      {plugins.length > 0 && (
        <div className={styles.group}>
          <SubHeading>Plugins</SubHeading>
          <ul className={styles.pluginList}>
            {plugins.map((p) => (
              <li key={p.name} className={styles.pluginRow}>
                <Package size={11} className={styles.pluginIcon} aria-hidden="true" />
                <span className={styles.pluginName}>{p.name}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Working folder */}
      {workingFolder !== null && (
        <div className={styles.group}>
          <SubHeading>Working folder</SubHeading>
          <ul className={styles.pathList}>
            <PathChip path={workingFolder} icon={FolderOpen} onOpenPath={onOpenPath} />
          </ul>
        </div>
      )}

      {/* Shared files */}
      {sharedFiles.length > 0 && (
        <div className={styles.group}>
          <SubHeading>Shared files</SubHeading>
          <ul className={styles.pathList}>
            {sharedFiles.map((f) => (
              <PathChip key={f} path={f} icon={Wrench} onOpenPath={onOpenPath} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
