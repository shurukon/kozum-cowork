/**
 * PluginDialog — real form for installing a plugin.
 *
 * Two paths:
 *   a) From a .zip file — button calls bridge().dialog.selectFiles(), shows chosen path.
 *   b) From GitHub — text field accepting owner/repo, owner/repo@ref, or full URL.
 *
 * Shows a spinner while installing (slow: network + extract).
 * Displays discovered contributions from the returned Plugin on success.
 * Shows backend error messages inline on failure.
 * bridge().plugins.installFromUrl handles both zip paths and GitHub URLs.
 */

import { useState, type ReactNode } from "react";
import { AlertCircle, Check, FileArchive, Github, Loader2, Package } from "lucide-react";
import type { Plugin } from "@shared/types.ts";
import { bridge } from "../bridge.ts";
import { Dialog } from "./Dialog.tsx";
import styles from "./PluginDialog.module.css";

interface Props {
  onSave: (plugin: Plugin) => void;
  onClose: () => void;
}

type Tab = "zip" | "github";

export function PluginDialog({ onSave, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("zip");
  const [zipPath, setZipPath] = useState<string | null>(null);
  const [githubRef, setGithubRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installed, setInstalled] = useState<Plugin | null>(null);

  async function pickZip() {
    try {
      const files = await bridge().dialog.selectFiles();
      if (files.length > 0) {
        setZipPath(files[0] ?? null);
        setError(null);
        setInstalled(null);
      }
    } catch {
      /* user cancelled */
    }
  }

  async function handleInstall() {
    setError(null);
    setInstalled(null);

    const src = tab === "zip" ? zipPath : githubRef.trim();
    if (!src) {
      setError(tab === "zip" ? "Choose a .zip file first." : "Enter a GitHub repo reference.");
      return;
    }

    setBusy(true);
    try {
      const res = await bridge().plugins.installFromUrl(src);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setInstalled(res.value);
      onSave(res.value);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const canInstall =
    !busy && (tab === "zip" ? Boolean(zipPath) : Boolean(githubRef.trim()));

  function contributionChips(plugin: Plugin) {
    const chips: ReactNode[] = [];
    if (plugin.skills.length)
      chips.push(
        <span key="skills" className={styles.chip}>
          {plugin.skills.length} skill{plugin.skills.length !== 1 ? "s" : ""}
        </span>,
      );
    if (plugin.agents.length)
      chips.push(
        <span key="agents" className={styles.chip}>
          {plugin.agents.length} agent{plugin.agents.length !== 1 ? "s" : ""}
        </span>,
      );
    if (plugin.commands.length)
      chips.push(
        <span key="commands" className={styles.chip}>
          {plugin.commands.length} command{plugin.commands.length !== 1 ? "s" : ""}
        </span>,
      );
    if (plugin.mcpServers.length)
      chips.push(
        <span key="mcp" className={styles.chip}>
          {plugin.mcpServers.length} MCP server{plugin.mcpServers.length !== 1 ? "s" : ""}
        </span>,
      );
    return chips;
  }

  const footer = (
    <>
      <button className={styles.cancelBtn} onClick={onClose} disabled={busy}>
        {installed ? "Close" : "Cancel"}
      </button>
      {!installed && (
        <button
          className={styles.installBtn}
          onClick={() => void handleInstall()}
          disabled={!canInstall}
        >
          {busy ? (
            <>
              <Loader2 size={14} className="kz-spin" />
              &nbsp;Installing…
            </>
          ) : (
            "Install"
          )}
        </button>
      )}
    </>
  );

  return (
    <Dialog title="Install plugin" onClose={onClose} footer={footer}>
      {/* Tab switcher */}
      <div className={styles.tabs} role="tablist">
        <button
          role="tab"
          aria-selected={tab === "zip"}
          className={`${styles.tab} ${tab === "zip" ? styles.tabActive : ""}`}
          onClick={() => {
            setTab("zip");
            setError(null);
            setInstalled(null);
          }}
          disabled={busy}
        >
          <FileArchive size={13} aria-hidden="true" /> From .zip file
        </button>
        <button
          role="tab"
          aria-selected={tab === "github"}
          className={`${styles.tab} ${tab === "github" ? styles.tabActive : ""}`}
          onClick={() => {
            setTab("github");
            setError(null);
            setInstalled(null);
          }}
          disabled={busy}
        >
          <Github size={13} aria-hidden="true" /> From GitHub
        </button>
      </div>

      {/* Zip path */}
      {tab === "zip" && (
        <div className={styles.section}>
          <button
            className={styles.filePicker}
            onClick={() => void pickZip()}
            disabled={busy}
            type="button"
          >
            <Package size={16} />
            <span
              className={`${styles.filePickerLabel} ${
                zipPath ? styles.filePickerLabelChosen : ""
              }`}
            >
              {zipPath ?? "Choose a .zip file…"}
            </span>
          </button>
        </div>
      )}

      {/* GitHub ref */}
      {tab === "github" && (
        <div className={styles.section}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="pd-github">
              GitHub reference
            </label>
            <input
              id="pd-github"
              className={styles.input}
              type="text"
              value={githubRef}
              placeholder="owner/repo"
              onChange={(e) => {
                setGithubRef(e.target.value);
                setError(null);
                setInstalled(null);
              }}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
            />
            <p className={styles.hint}>
              Accepted forms: <code>owner/repo</code>,{" "}
              <code>owner/repo@ref</code>, or{" "}
              <code>https://github.com/owner/repo</code>
            </p>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className={styles.error} role="alert">
          <AlertCircle size={15} />
          <span>{error}</span>
        </div>
      )}

      {/* Success */}
      {installed && (
        <div className={styles.success}>
          <Check size={15} />
          <div>
            <div>
              <strong>{installed.name}</strong> installed successfully.
            </div>
            {contributionChips(installed).length > 0 && (
              <div className={styles.contributions}>
                {contributionChips(installed)}
              </div>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
