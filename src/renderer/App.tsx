/**
 * Application shell.
 *
 * Owns layout plus the state that is genuinely global: mode, navigation,
 * settings, and the catalogues Settings needs. Everything a control does goes
 * through `bridge()` to the main process — there are deliberately no local-only
 * handlers here, because the previous revision shipped placeholder callbacks
 * and the whole UI was inert as a result.
 *
 * Cowork and Code state lives in the session store keyed by mode, so switching
 * tabs is a view change and never interrupts a running turn.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  ApiKeyEntry,
  AppSettings,
  McpServerConfig,
  Mode,
  ModelInfo,
  ModelSelection,
  PermissionMode,
  Plugin,
  Project,
  ProviderPreset,
  ScheduledTask,
  Session,
  Skill,
} from "@shared/types.ts";
import { bridge } from "./bridge.ts";
import type { AddMenuKind } from "./components/AddMenu.tsx";
import type { PreviewTarget } from "./components/PreviewPanel.tsx";
import type { NavKey } from "./components/Sidebar.tsx";
import type { ScheduleDialogPrefill } from "./components/ScheduleDialog.tsx";
import { TitleBar } from "./components/TitleBar.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { HomeView } from "./components/HomeView.tsx";
import { CodeHome } from "./components/CodeHome.tsx";
import { ComposerBar } from "./components/ComposerBar.tsx";
import { ChatView } from "./components/ChatView.tsx";
import { RightPanel } from "./components/RightPanel.tsx";
import { PreviewPanel } from "./components/PreviewPanel.tsx";
import { Settings } from "./components/Settings.tsx";
import { FirstRun } from "./components/FirstRun.tsx";
import { PermissionPicker } from "./components/PermissionPicker.tsx";
import { Scheduled } from "./pages/Scheduled.tsx";
import { Projects } from "./pages/Projects.tsx";
import { ToastRegion } from "./components/Toast.tsx";
import { ScheduleDialog } from "./components/ScheduleDialog.tsx";
import { ConnectorDialog } from "./components/ConnectorDialog.tsx";
import { PluginDialog } from "./components/PluginDialog.tsx";
import { useSessionStore } from "./store/session.ts";
import { useTheme } from "./hooks/useTheme.ts";
import { useToasts } from "./hooks/useToasts.ts";
import styles from "./App.module.css";

export function App() {
  const [mode, setMode] = useState<Mode>("cowork");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [nav, setNav] = useState<NavKey>("new");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialPane, setSettingsInitialPane] = useState<
    "general" | "providers" | "cowork" | "code" | "skills" | "connectors" | "plugins"
  >("general");
  const [skippedSetup, setSkippedSetup] = useState(false);

  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [keys, setKeys] = useState<Record<string, ApiKeyEntry[]>>({});
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, ModelInfo[]>>({});
  const [skills, setSkills] = useState<Skill[]>([]);
  const [connectors, setConnectors] = useState<McpServerConfig[]>([]);
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [scheduled, setScheduled] = useState<ScheduledTask[]>([]);
  const [recents, setRecents] = useState<Array<{ id: string; title: string }>>([]);
  const [rules, setRules] = useState("");

  // Code-mode folders (starts from settings.general.defaultFolders.code)
  const [codeFolders, setCodeFolders] = useState<string[]>([]);

  // Files attached by the user for context tracking in RightPanel
  const [sharedFiles, setSharedFiles] = useState<string[]>([]);

  // Preview panel target (file / url / project / computer / mcp)
  const [previewTarget, setPreviewTarget] = useState<PreviewTarget | null>(null);

  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const { toasts, push: pushToast, dismiss: dismissToast } = useToasts();

  // Dialog open state
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false);
  const [schedulePrefill, setSchedulePrefill] = useState<ScheduleDialogPrefill | undefined>(
    undefined,
  );
  const [connectorDialogOpen, setConnectorDialogOpen] = useState(false);
  const [pluginDialogOpen, setPluginDialogOpen] = useState(false);

  // Compatibility shim: setBanner is called throughout this file to surface
  // errors and info notices. Route it through the toast system so all existing
  // call-sites keep working without being individually rewritten.
  function setBanner(msg: string | null) {
    if (!msg) return; // clearing is a no-op — toasts auto-dismiss
    pushToast("error", msg);
  }

  const modeState = useSessionStore((s) => s[mode]);
  const applyEvent = useSessionStore((s) => s.applyEvent);
  const addUserMessage = useSessionStore((s) => s.addUserMessage);
  const clearMode = useSessionStore((s) => s.clearMode);

  // Sessions are per-mode; remember which one each tab was last on so switching
  // back returns you to your place instead of a blank screen.
  const lastSession = useRef<Record<Mode, string | null>>({ cowork: null, code: null });

  useTheme(settings);

  /* ------------------------------------------------------------ loading -- */

  const reloadKeys = useCallback(async (list: ProviderPreset[]) => {
    const next: Record<string, ApiKeyEntry[]> = {};
    await Promise.all(
      list.map(async (p) => {
        try {
          next[p.id] = await bridge().providers.listKeys(p.id);
        } catch {
          next[p.id] = [];
        }
      }),
    );
    setKeys(next);
  }, []);

  const reloadModels = useCallback(async (list: ProviderPreset[]) => {
    const next: Record<string, ModelInfo[]> = {};
    await Promise.all(
      list.map(async (p) => {
        try {
          next[p.id] = await bridge().providers.listModels(p.id);
        } catch {
          next[p.id] = [];
        }
      }),
    );
    setModelsByProvider(next);
  }, []);

  const reloadPresets = useCallback(async () => {
    const b = bridge();
    const p = await b.providers.presets();
    setPresets(p);
    await Promise.all([reloadKeys(p), reloadModels(p)]);
  }, [reloadKeys, reloadModels]);

  const reloadExtensions = useCallback(async () => {
    const b = bridge();
    const [sk, mc, pl] = await Promise.allSettled([
      b.skills.list(),
      b.mcp.list(),
      b.plugins.list(),
    ]);
    if (sk.status === "fulfilled") setSkills(sk.value);
    if (mc.status === "fulfilled") setConnectors(mc.value);
    if (pl.status === "fulfilled") setPlugins(pl.value);
  }, []);

  const reloadSessions = useCallback(async (m: Mode) => {
    try {
      const list = await bridge().sessions.list(m);
      setRecents(list.slice(0, 30).map((s) => ({ id: s.id, title: s.title || "Untitled" })));
    } catch {
      setRecents([]);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const b = bridge();
        const [s, p] = await Promise.all([b.settings.get(), b.providers.presets()]);
        if (cancelled) return;
        setSettings(s);
        setPresets(p);

        // Seed code folders from default setting
        if (s.general.defaultFolders.code) {
          setCodeFolders([s.general.defaultFolders.code]);
        }

        await Promise.all([reloadKeys(p), reloadModels(p)]);
        await reloadExtensions();

        // Load standing rules
        try {
          const rulesResult = await bridge().memory.getRules();
          if (rulesResult.ok) setRules(rulesResult.value);
        } catch {
          /* memory may not be available yet */
        }

        try {
          setScheduled(await b.schedule.list());
        } catch {
          /* scheduler may be disabled */
        }
      } catch (e) {
        // If the bridge itself is missing the app is unusable — say so loudly
        // rather than rendering a shell that silently does nothing.
        setBanner(
          `Could not reach the application backend: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKeys, reloadModels, reloadExtensions]);

  useEffect(() => {
    void reloadSessions(mode);
  }, [mode, reloadSessions]);

  /* ------------------------------------------------------- agent events -- */

  useEffect(() => {
    let off: (() => void) | undefined;
    try {
      off = bridge().sessions.onEvent((e) => {
        applyEvent(e);
        if (e.type === "error") setBanner(e.message);
      });
    } catch {
      /* reported by the loader above */
    }
    return () => off?.();
  }, [applyEvent]);

  /* -------------------------------------------------------------- state -- */

  const selection = settings?.[mode].selection;
  const configured = Boolean(selection?.providerId && selection?.modelId);

  const inSession = activeSessionId !== null && modeState.messages.length > 0;
  const needsSetup = settings !== null && !configured && !skippedSetup;

  async function patchSettings(patch: Partial<AppSettings>) {
    try {
      const next = await bridge().settings.set(patch);
      setSettings(next);
    } catch (e) {
      setBanner(e instanceof Error ? e.message : String(e));
    }
  }

  /* ------------------------------------------------------------ actions -- */

  async function ensureSession(): Promise<string | null> {
    if (activeSessionId) return activeSessionId;
    if (!selection) {
      setBanner("Choose a provider and model before starting a task.");
      return null;
    }
    const res = await bridge().sessions.create(mode, selection);
    if (!res.ok) {
      setBanner(res.error);
      return null;
    }
    setActiveSessionId(res.value.id);
    lastSession.current[mode] = res.value.id;
    void reloadSessions(mode);
    return res.value.id;
  }

  async function handleSubmit(text: string) {
    setBanner(null);
    if (!configured) {
      setSkippedSetup(false);
      setBanner("Connect a provider and pick a model first.");
      return;
    }
    const sid = await ensureSession();
    if (!sid) return;

    // Render the user's turn immediately; the backend echoes it back on reload.
    addUserMessage(mode, {
      id: `local-${Date.now()}`,
      role: "user",
      content: [{ type: "text", text }],
      createdAt: Date.now(),
    });

    const res = await bridge().sessions.send(sid, text);
    if (!res.ok) setBanner(res.error);
  }

  async function handleCancel() {
    if (!activeSessionId) return;
    const res = await bridge().sessions.cancel(activeSessionId);
    if (!res.ok) setBanner(res.error);
  }

  /**
   * Handles all AddMenu kinds from ComposerBar/ChatView.
   * files → dialog.selectFiles, connectors → ConnectorDialog,
   * skills → Settings(skills pane), plugins → PluginDialog.
   */
  async function handleAttach(kind: AddMenuKind) {
    switch (kind) {
      case "files": {
        try {
          const files = await bridge().dialog.selectFiles();
          if (!files.length) return;
          setSharedFiles((prev) => [...prev, ...files]);
          pushToast(
            "info",
            `Attached ${files.length} file${files.length > 1 ? "s" : ""}. ` +
              `Mention them in your message: ${files.slice(0, 3).join(", ")}` +
              (files.length > 3 ? ` and ${files.length - 3} more` : ""),
          );
        } catch (e) {
          setBanner(e instanceof Error ? e.message : String(e));
        }
        break;
      }
      case "connectors":
        setConnectorDialogOpen(true);
        break;
      case "skills":
        openSettings("skills");
        break;
      case "plugins":
        setPluginDialogOpen(true);
        break;
    }
  }

  /**
   * Per-mode model selection. Persists immediately to settings[mode].selection
   * via settings.set and updates local state. No modal required.
   */
  async function handleSelectionChange(next: ModelSelection) {
    if (!settings) return;
    await patchSettings({
      [mode]: { ...settings[mode], selection: next },
    } as Partial<AppSettings>);
  }

  /**
   * Refresh models for a provider, update local cache, and return.
   */
  async function handleRefreshModels(providerId: string): Promise<void> {
    const res = await bridge().providers.refreshModels(providerId);
    if (!res.ok) {
      setBanner(res.error);
      return;
    }
    setModelsByProvider((prev) => ({ ...prev, [providerId]: res.value }));
  }

  /**
   * NEW: addKey no longer takes a label — pass empty string and let the bridge
   * assign "Key N". meta carries accountId for Cloudflare, etc.
   */
  async function handleAddKey(
    providerId: string,
    rawKey: string,
    meta?: Record<string, string>,
  ) {
    const res = await bridge().providers.addKey(providerId, "", rawKey, meta);
    if (!res.ok) {
      setBanner(res.error);
      return;
    }
    await reloadKeys(presets);
  }

  async function handleRemoveKey(keyId: string) {
    const res = await bridge().providers.removeKey(keyId);
    if (!res.ok) setBanner(res.error);
    await reloadKeys(presets);
  }

  /**
   * FirstRun: still calls addKey with a label for backward compat with the
   * component (it passes "Default" as the label — we forward to the new sig).
   */
  async function handleFirstRunKey(
    providerId: string,
    label: string,
    raw: string,
  ): Promise<string | null> {
    const res = await bridge().providers.addKey(providerId, label, raw);
    if (!res.ok) return res.error;
    await reloadKeys(presets);
    return null;
  }

  async function handleAddCustomProvider(name: string, baseUrl: string): Promise<void> {
    const res = await bridge().providers.addCustom({ name, baseUrl });
    if (!res.ok) throw new Error(res.error);
    await reloadPresets();
    pushToast("success", `Custom provider "${name}" added.`);
  }

  async function handleRemoveCustomProvider(id: string) {
    const res = await bridge().providers.removeCustom(id);
    if (!res.ok) {
      setBanner(res.error);
      return;
    }
    await reloadPresets();
    pushToast("success", "Provider removed.");
  }

  async function chooseModel(providerId: string, modelId: string) {
    if (!settings) return;
    const keyId = keys[providerId]?.[0]?.id ?? null;
    await patchSettings({
      [mode]: { ...settings[mode], selection: { providerId, keyId, modelId } },
    } as Partial<AppSettings>);
    setSkippedSetup(true);
  }

  async function pickWorkingFolder() {
    try {
      const dir = await bridge().dialog.selectFolder();
      if (!dir) return;
      if (!settings) return;
      // Persist as the mode's default folder
      await patchSettings({
        general: {
          ...settings.general,
          defaultFolders: {
            ...settings.general.defaultFolders,
            [mode]: dir,
          },
        },
      });
      pushToast("success", `Working folder set to ${dir}`);
    } catch (e) {
      setBanner(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Settings.onPickFolder — opens the native folder picker and saves to
   * settings.general.defaultFolders[pickedMode].
   */
  async function handlePickFolder(pickedMode: Mode) {
    try {
      const dir = await bridge().dialog.selectFolder();
      if (!dir || !settings) return;
      await patchSettings({
        general: {
          ...settings.general,
          defaultFolders: {
            ...settings.general.defaultFolders,
            [pickedMode]: dir,
          },
        },
      });
      pushToast("success", `Default folder for ${pickedMode} set to ${dir}`);
    } catch (e) {
      setBanner(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * CodeHome: "Add another folder" calls selectFolder and appends to codeFolders.
   */
  async function handleAddCodeFolder() {
    try {
      const dir = await bridge().dialog.selectFolder();
      if (!dir) return;
      setCodeFolders((prev) => (prev.includes(dir) ? prev : [...prev, dir]));
      pushToast("info", `Added folder: ${dir}`);
    } catch (e) {
      setBanner(e instanceof Error ? e.message : String(e));
    }
  }

  async function setPermissionMode(pm: PermissionMode) {
    if (!settings) return;
    if (activeSessionId) {
      // In a session: update via bridge
      const res = await bridge().sessions.setPermissionMode(activeSessionId, pm);
      if (!res.ok) {
        setBanner(res.error);
        return;
      }
    }
    // Also persist to settings for future sessions
    await patchSettings({ code: { ...settings.code, permissionMode: pm } });
  }

  function openSettings(
    pane: "general" | "providers" | "cowork" | "code" | "skills" | "connectors" | "plugins" = "general",
  ) {
    setSettingsInitialPane(pane);
    setSettingsOpen(true);
  }

  function handleNavKey(key: NavKey) {
    if (key === "customize") {
      // Customize → open Settings directly on the Skills pane (per spec).
      // Set the initial pane before opening so the guard sees openSettings().
      setSettingsInitialPane("skills");
      openSettings();
      return;
    }
    setNav(key);
    if (key === "new") setActiveSessionId(null);
  }

  function switchMode(m: Mode) {
    lastSession.current[mode] = activeSessionId;
    setMode(m);
    setNav("new");
    // Restore where this tab was; the other mode keeps running regardless.
    setActiveSessionId(lastSession.current[m]);
  }

  /* ------------------------------------------------- rules (memory) ------ */

  async function handleRulesBlur() {
    const res = await bridge().memory.setRules(rules);
    if (!res.ok) setBanner(res.error);
  }

  /* ------------------------------------------------ conversation actions - */

  async function handleConversationOpen(id: string) {
    setActiveSessionId(id);
    setNav("new");
  }

  async function handleConversationRename(id: string, title: string) {
    const res = await bridge().sessions.rename(id, title);
    if (!res.ok) {
      setBanner(res.error);
      return;
    }
    await reloadSessions(mode);
    pushToast("success", "Session renamed.");
  }

  async function handleConversationBranch(id: string) {
    const res = await bridge().sessions.branch(id);
    if (!res.ok) {
      setBanner(res.error);
      return;
    }
    const newSession: Session = res.value;
    await reloadSessions(mode);
    // Open the new branched session
    setActiveSessionId(newSession.id);
    lastSession.current[mode] = newSession.id;
    // Clear message store for this mode so it reloads
    clearMode(mode);
    setNav("new");
    pushToast("success", "Session branched.");
  }

  async function handleConversationArchive(id: string) {
    const res = await bridge().sessions.archive(id);
    if (!res.ok) {
      setBanner(res.error);
      return;
    }
    await reloadSessions(mode);
    if (activeSessionId === id) {
      setActiveSessionId(null);
    }
    pushToast("success", "Session archived.");
  }

  async function handleConversationDelete(id: string) {
    const res = await bridge().sessions.delete(id);
    if (!res.ok) {
      setBanner(res.error);
      return;
    }
    await reloadSessions(mode);
    if (activeSessionId === id) {
      setActiveSessionId(null);
    }
    pushToast("success", "Session deleted.");
  }

  /* ------------------------------------------------------------- render -- */

  // Derive the tools used from active modeState toolCards
  const toolsUsed = Array.from(modeState.toolCards.values()).map((tc) => tc.name);

  // Current session's working folder (or mode default)
  const sessionWorkingFolder = settings?.general.defaultFolders[mode] ?? null;

  // Per-mode selection (with fallback to avoid null)
  const currentSelection: ModelSelection = selection ?? {
    providerId: "",
    keyId: null,
    modelId: "",
  };

  // PermissionPicker for Code mode
  const codePermissionPicker = settings ? (
    <PermissionPicker
      value={settings.code.permissionMode}
      onChange={(pm) => void setPermissionMode(pm)}
    />
  ) : undefined;

  // ComposerBar shared across Code home and Cowork home
  const composerBarShared = (
    <ComposerBar
      busy={modeState.streamingMessageId !== null}
      onSend={(t) => void handleSubmit(t)}
      onCancel={() => void handleCancel()}
      onAttach={(kind) => void handleAttach(kind)}
      selection={currentSelection}
      presets={presets}
      keysByProvider={keys}
      modelsByProvider={modelsByProvider}
      onSelectionChange={(next) => void handleSelectionChange(next)}
      onRefreshModels={(pid) => handleRefreshModels(pid)}
      permissionSlot={mode === "code" ? codePermissionPicker : undefined}
    />
  );

  return (
    <div className={styles.app}>
      <TitleBar
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        sidebarOpen={sidebarOpen}
      />

      <ToastRegion toasts={toasts} onDismiss={dismissToast} />

      <div className={styles.body}>
        {sidebarOpen && (
          <Sidebar
            mode={mode}
            onModeChange={switchMode}
            active={nav}
            onNavigate={handleNavKey}
            recents={recents}
            accountLabel={settings?.general.userName || "You"}
            providerLabel={selection?.providerId || "No provider"}
            onAccountClick={openSettings}
            onSelectRecent={(id) => {
              setActiveSessionId(id);
              setNav("new");
            }}
            conversationCallbacks={{
              onOpen: (id) => void handleConversationOpen(id),
              onRename: (id, title) => void handleConversationRename(id, title),
              onBranch: (id) => void handleConversationBranch(id),
              onArchive: (id) => void handleConversationArchive(id),
              onDelete: (id) => void handleConversationDelete(id),
            }}
          />
        )}

        <main className={styles.content}>
          {nav === "new" &&
            (needsSetup ? (
              <FirstRun
                presets={presets}
                onSubmit={handleFirstRunKey}
                onRefreshModels={async (pid) => {
                  const res = await bridge().providers.refreshModels(pid);
                  if (!res.ok) throw new Error(res.error);
                  return res.value;
                }}
                onChooseModel={(p, m) => void chooseModel(p, m)}
                onSkip={() => setSkippedSetup(true)}
              />
            ) : inSession ? (
              <div className={styles.sessionWrap}>
                <ChatView
                  mode={mode}
                  sessionId={activeSessionId!}
                  onSend={(t) => void handleSubmit(t)}
                  onCancel={() => void handleCancel()}
                  onAttach={(kind) => void handleAttach(kind)}
                  selection={currentSelection}
                  presets={presets}
                  keysByProvider={keys}
                  modelsByProvider={modelsByProvider}
                  onSelectionChange={(next) => void handleSelectionChange(next)}
                  onRefreshModels={(pid) => handleRefreshModels(pid)}
                  permissionSlot={mode === "code" ? codePermissionPicker : undefined}
                  onOpenFile={(path) => setPreviewTarget({ kind: "file", path })}
                />
              </div>
            ) : mode === "code" ? (
              <CodeHome
                userName={settings?.general.userName ?? ""}
                folders={codeFolders}
                onAddFolder={() => void handleAddCodeFolder()}
                onOpenFolder={(path) => setPreviewTarget({ kind: "project", path })}
                composerSlot={composerBarShared}
              />
            ) : (
              <HomeView
                userName={settings?.general.userName ?? ""}
                composerSlot={composerBarShared}
                onPickFolder={() => void pickWorkingFolder()}
                folderLabel={settings?.general.defaultFolders?.cowork ?? null}
              />
            ))}

          {nav === "scheduled" && (
            <Scheduled
              tasks={scheduled}
              keepAwake={settings?.scheduler.keepAwake ?? true}
              onToggleKeepAwake={() => {
                if (!settings) return;
                void patchSettings({
                  scheduler: {
                    ...settings.scheduler,
                    keepAwake: !settings.scheduler.keepAwake,
                  },
                });
              }}
              onNewTask={() => openScheduleDialog()}
              onDailyBrief={() =>
                openScheduleDialog({
                  name: "Daily brief",
                  prompt:
                    "Summarise what changed since yesterday and what needs my attention today.",
                  cadenceKind: "daily",
                  hour: 8,
                  minute: 0,
                })
              }
              onWeeklyReview={() =>
                openScheduleDialog({
                  name: "Weekly review",
                  prompt: "Review this week's work and produce a short written summary.",
                  cadenceKind: "weekly",
                  hour: 17,
                  minute: 0,
                  dayOfWeek: 5,
                })
              }
            />
          )}

          {nav === "projects" && (
            <Projects
              projects={projects}
              onNew={() => void createProject()}
              onOpen={(id) => {
                const p = projects.find((x) => x.id === id);
                if (p) pushToast("info", `Opened project ${p.name}`);
              }}
            />
          )}
        </main>

        {inSession && (
          <RightPanel
            tasks={modeState.tasks}
            mcpServers={connectors.filter((c) => c.enabled)}
            plugins={plugins.filter((p) => p.enabled).map((p) => ({ name: p.name }))}
            toolsUsed={toolsUsed}
            workingFolder={sessionWorkingFolder}
            sharedFiles={sharedFiles}
            onOpenPath={(path) => setPreviewTarget({ kind: "file", path })}
          />
        )}

        {previewTarget && (
          <PreviewPanel
            target={previewTarget}
            onClose={() => setPreviewTarget(null)}
            onRefresh={() => {
              // Force re-mount of the inner preview by toggling target
              const t = previewTarget;
              setPreviewTarget(null);
              setTimeout(() => setPreviewTarget(t), 0);
            }}
          />
        )}
      </div>

      {settingsOpen && settings && (
        <Settings
          settings={settings}
          presets={presets}
          keys={keys}
          skills={skills}
          connectors={connectors}
          plugins={plugins}
          rules={rules}
          onRulesChange={setRules}
          onRulesBlur={() => void handleRulesBlur()}
          onSave={(patch) => void patchSettings(patch)}
          onAddKey={(pid, rawKey, meta) => void handleAddKey(pid, rawKey, meta)}
          onRemoveKey={(k) => void handleRemoveKey(k)}
          onAddCustomProvider={(name, baseUrl) => handleAddCustomProvider(name, baseUrl)}
          onRemoveCustomProvider={(id) => void handleRemoveCustomProvider(id)}
          onToggleSkill={(id, en) => void toggle(() => bridge().skills.setEnabled(id, en))}
          onToggleConnector={(id, en) => void toggle(() => bridge().mcp.setEnabled(id, en))}
          onTogglePlugin={(id, en) => void toggle(() => bridge().plugins.setEnabled(id, en))}
          onAddSkill={() =>
            pushToast(
              "info",
              "Ask Kozum to install a skill, or drop a SKILL.md into the skills folder.",
            )
          }
          onAddConnector={() => setConnectorDialogOpen(true)}
          onAddPlugin={() => setPluginDialogOpen(true)}
          onPickFolder={(m) => void handlePickFolder(m)}
          onClose={() => setSettingsOpen(false)}
          initialPane={settingsInitialPane}
        />
      )}

      {scheduleDialogOpen && (
        <ScheduleDialog
          prefill={schedulePrefill}
          onSave={(task) => {
            setScheduleDialogOpen(false);
            setScheduled((prev) => [...prev, task]);
            pushToast("success", `Scheduled task "${task.name}" created.`);
          }}
          onClose={() => setScheduleDialogOpen(false)}
        />
      )}

      {connectorDialogOpen && (
        <ConnectorDialog
          onSave={(server) => {
            setConnectorDialogOpen(false);
            void reloadExtensions();
            pushToast(
              "success",
              `Connected to "${server.name}"` +
                (server.toolCount > 0
                  ? ` — ${server.toolCount} tool${server.toolCount !== 1 ? "s" : ""}`
                  : ""),
            );
          }}
          onClose={() => setConnectorDialogOpen(false)}
        />
      )}

      {pluginDialogOpen && (
        <PluginDialog
          onSave={(plugin) => {
            setPluginDialogOpen(false);
            void reloadExtensions();
            pushToast("success", `Plugin "${plugin.name}" installed.`);
          }}
          onClose={() => setPluginDialogOpen(false)}
        />
      )}
    </div>
  );

  /* ---------------------------------------------------------- helpers --- */

  async function toggle(fn: () => Promise<{ ok: boolean; error?: string }>) {
    const res = await fn();
    if (!res.ok && res.error) setBanner(res.error);
    await reloadExtensions();
  }

  async function createProject() {
    const dir = await bridge().dialog.selectFolder();
    if (!dir) return;
    const res = await bridge().projects.create({
      name: dir.split(/[\\/]/).pop() || "Project",
      folder: dir,
      mode,
    });
    if (!res.ok) {
      setBanner(res.error);
      return;
    }
    setProjects(await bridge().projects.list());
  }

  function openScheduleDialog(prefill?: ScheduleDialogPrefill) {
    setSchedulePrefill(prefill);
    setScheduleDialogOpen(true);
  }
}
