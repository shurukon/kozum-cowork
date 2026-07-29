/**
 * ConnectorDialog — real form for adding an MCP server.
 *
 * Fields: Name, Server URL (required), Auth token (optional password input),
 * Header name (optional, under "Advanced" disclosure, defaults to Authorization).
 *
 * Test connection: validates URL shape client-side and informs the user that the
 * real connectivity check happens on save (bridge().mcp has no probe-only call).
 *
 * On save: calls bridge().mcp.add and reports the server name + tool count.
 */

import { useState } from "react";
import { AlertCircle, ChevronRight, Info, Loader2 } from "lucide-react";
import type { McpServerConfig } from "@shared/types.ts";
import { bridge } from "../bridge.ts";
import { Dialog } from "./Dialog.tsx";
import styles from "./ConnectorDialog.module.css";

interface Props {
  onSave: (server: McpServerConfig) => void;
  onClose: () => void;
}

type TestState = "idle" | "client-ok" | "client-fail";

export function ConnectorDialog({ onSave, onClose }: Props) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [headerName, setHeaderName] = useState("Authorization");
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [testState, setTestState] = useState<TestState>("idle");
  const [testMessage, setTestMessage] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Parse URL and derive a reasonable server name when the user hasn't typed one. */
  function deriveNameFromUrl(raw: string): string {
    try {
      return new URL(raw).hostname;
    } catch {
      return raw.split("/").filter(Boolean).pop() ?? "MCP server";
    }
  }

  function validateUrl(raw: string): string | null {
    if (!raw.trim()) return "Server URL is required.";
    try {
      const u = new URL(raw.trim());
      if (u.protocol !== "http:" && u.protocol !== "https:")
        return "URL must use http or https.";
      return null;
    } catch {
      return "That doesn't look like a valid URL.";
    }
  }

  function handleTest() {
    const urlErr = validateUrl(url);
    if (urlErr) {
      setTestState("client-fail");
      setTestMessage(urlErr);
      return;
    }
    // bridge().mcp has no probe-only method — be honest about what we checked.
    setTestState("client-ok");
    setTestMessage(
      "URL format looks valid. The real connectivity check (handshake + tool list) runs when you save.",
    );
  }

  async function handleSave() {
    setError(null);
    const urlErr = validateUrl(url);
    if (urlErr) {
      setError(urlErr);
      return;
    }

    setBusy(true);
    try {
      const serverName = name.trim() || deriveNameFromUrl(url.trim());
      const res = await bridge().mcp.add({
        name: serverName,
        enabled: true,
        transport: "http",
        url: url.trim(),
        hasAuthToken: Boolean(token.trim()),
        authToken: token.trim() || undefined,
        authHeader: headerName.trim() || "Authorization",
        installedByAgent: false,
      } as never);

      if (!res.ok) {
        setError(res.error);
        return;
      }
      onSave(res.value);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const footer = (
    <>
      <button className={styles.cancelBtn} onClick={onClose} disabled={busy}>
        Cancel
      </button>
      <button
        className={styles.testBtn}
        onClick={handleTest}
        disabled={busy || !url.trim()}
        type="button"
      >
        Test connection
      </button>
      <button
        className={styles.saveBtn}
        onClick={() => void handleSave()}
        disabled={busy || !url.trim()}
      >
        {busy ? <Loader2 size={14} className="kz-spin" /> : "Connect"}
      </button>
    </>
  );

  return (
    <Dialog title="Add MCP connector" onClose={onClose} footer={footer}>
      {/* Name */}
      <div className={styles.field}>
        <label className={styles.label} htmlFor="cd-name">
          Name
        </label>
        <input
          id="cd-name"
          className={styles.input}
          type="text"
          value={name}
          placeholder="Auto-detected from URL"
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
        />
      </div>

      {/* Server URL */}
      <div className={styles.field}>
        <label className={styles.label} htmlFor="cd-url">
          Server URL <span aria-hidden="true">*</span>
        </label>
        <input
          id="cd-url"
          className={styles.input}
          type="url"
          value={url}
          placeholder="https://example.com/mcp"
          onChange={(e) => {
            setUrl(e.target.value);
            setTestState("idle");
            setTestMessage(null);
            setError(null);
          }}
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
        />
      </div>

      {/* Auth token */}
      <div className={styles.field}>
        <label className={styles.label} htmlFor="cd-token">
          Auth token (optional)
        </label>
        <input
          id="cd-token"
          className={styles.input}
          type="password"
          value={token}
          placeholder="sk-…"
          onChange={(e) => setToken(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
        />
        <p className={styles.hint}>
          Stored encrypted by the OS keychain and never leaves this machine
          except to the server you connected.
        </p>
      </div>

      {/* Advanced disclosure */}
      <div className={styles.advanced}>
        <button
          className={styles.advancedToggle}
          onClick={() => setAdvancedOpen((v) => !v)}
          type="button"
          aria-expanded={advancedOpen}
        >
          <ChevronRight
            size={14}
            className={`${styles.advancedChevron} ${
              advancedOpen ? styles.advancedChevronOpen : ""
            }`}
          />
          Advanced
        </button>

        {advancedOpen && (
          <div className={styles.field}>
            <label className={styles.label} htmlFor="cd-header">
              Auth header name
            </label>
            <input
              id="cd-header"
              className={styles.input}
              type="text"
              value={headerName}
              placeholder="Authorization"
              onChange={(e) => setHeaderName(e.target.value)}
              disabled={busy}
            />
            <p className={styles.hint}>
              The HTTP header the token is sent in. Most servers use{" "}
              <code>Authorization</code>.
            </p>
          </div>
        )}
      </div>

      {/* Test connection result */}
      {testState === "client-ok" && testMessage && (
        <div className={`${styles.testResult} ${styles.testResultWarn}`}>
          <Info size={15} />
          <span>{testMessage}</span>
        </div>
      )}
      {testState === "client-fail" && testMessage && (
        <div className={`${styles.testResult} ${styles.testResultWarn}`}>
          <AlertCircle size={15} />
          <span>{testMessage}</span>
        </div>
      )}

      {/* Save error */}
      {error && (
        <div className={styles.error} role="alert">
          <AlertCircle size={15} />
          <span>{error}</span>
        </div>
      )}

    </Dialog>
  );
}
