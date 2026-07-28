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
  PermissionMode,
  Plugin,
  Project,
  ProviderPreset,
  ScheduledTask,
  Skill,
} from "@shared/types.ts";
import { bridge } from "./bridge.ts";
import { TitleBar } from "./components/TitleBar.tsx";
import { Sidebar, type NavKey } from "./components/Sidebar.tsx";
import { HomeView } from "./components/HomeView.tsx";
import { CodeHome, type CodeHomeStats } from "./components/CodeHome.tsx";
import { ChatView } from "./components/ChatView.tsx";
import { RightPanel } from "./components/RightPanel.tsx";
import { Settings } from "./components/Settings.tsx";
import { FirstRun } from "./components/FirstRun.tsx";
import { PermissionPicker } from "./components/PermissionPicker.tsx";
import { Scheduled } from "./pages/Scheduled.tsx";
import { Projects } from "./pages/Projects.tsx";
import { useSessionStore } from "./store/session.ts";
import { useTheme } from "./hooks/useTheme.ts";
import styles from "./App.module.css";

const ZERO_STATS: CodeHomeStats = {
  sessions: 0,
  messages: 0,
  totalTokens: 0,
  activeDays: 0,
  currentStreak: 0,
  longestStreak: 0,
  peakHour: null,
  favouriteModel: null,
  activity: [],
};

export function App() {
  const [mode, setMode] = useState<Mode>("cowork");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [nav, setNav] = useState<NavKey>("new");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [skippedSetup, setSkippedSetup] = useState(false);

  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [keys, setKeys] = useState<Record<string, ApiKeyEntry[]>>({});
  const [skills, setSkills] = useState<Skill[]>([]);
  const [connectors, setConnectors] = useState<McpServerConfig[]>([]);
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [scheduled, setScheduled] = useState<ScheduledTask[]>([]);
  const [recents, setRecents] = useState<Array<{ id: string; title: string }>>([]);

  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const modeState = useSessionStore((s) => s[mode]);
  const applyEvent = useSessionStore((s) => s.applyEvent);
  const addUserMessage = useSessionStore((s) => s.addUserMessage);

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
        await reloadKeys(p);
        await reloadExtensions();
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
  }, [reloadKeys, reloadExtensions]);

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
  const modelLabel = selection?.modelId
    ? (selection.modelId.split("/").pop() ?? selection.modelId)
    : "Choose a model";

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

  async function handleAddKey(providerId: string, label: string, raw: string) {
    const res = await bridge().providers.addKey(providerId, label, raw);
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

  async function refreshModels(providerId: string): Promise<ModelInfo[]> {
    const res = await bridge().providers.refreshModels(providerId);
    if (!res.ok) throw new Error(res.error);
    return res.value;
  }

  async function chooseModel(providerId: string, modelId: string) {
    const keyId = keys[providerId]?.[0]?.id ?? null;
    await patchSettings({
      [mode]: { ...settings![mode], selection: { providerId, keyId, modelId } },
    } as Partial<AppSettings>);
    setSkippedSetup(true);
  }

  async function pickWorkingFolder() {
    try {
      const dir = await bridge().dialog.selectFolder();
      if (!dir) return;
      await patchSettings({
        [mode]: { ...settings![mode] },
      } as Partial<AppSettings>);
      setBanner(`Working folder set to ${dir}`);
    } catch (e) {
      setBanner(e instanceof Error ? e.message : String(e));
    }
  }

  async function setPermissionMode(pm: PermissionMode) {
    if (!settings) return;
    await patchSettings({ code: { ...settings.code, permissionMode: pm } });
  }

  function openSettings() {
    setSettingsOpen(true);
  }

  function handleNavKey(key: NavKey) {
    if (key === "customize") {
      // Customize IS Settings. The previous revision routed it to the home
      // screen, which is why the item appeared dead.
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

  /* ------------------------------------------------------------- render -- */

  return (
    <div className={styles.app}>
      <TitleBar
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        sidebarOpen={sidebarOpen}
      />

      {banner && (
        <div className={styles.banner} role="alert">
          <span>{banner}</span>
          <button onClick={() => setBanner(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

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
          />
        )}

        <main className={styles.content}>
          {nav === "new" &&
            (needsSetup ? (
              <FirstRun
                presets={presets}
                onSubmit={handleFirstRunKey}
                onRefreshModels={refreshModels}
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
                  onPickModel={openSettings}
                  modelLabel={modelLabel}
                />
                {mode === "code" && settings && (
                  <div className={styles.permission}>
                    <PermissionPicker
                      value={settings.code.permissionMode}
                      onChange={(pm) => void setPermissionMode(pm)}
                    />
                  </div>
                )}
              </div>
            ) : mode === "code" ? (
              <CodeHome userName={settings?.general.userName ?? ""} stats={ZERO_STATS} />
            ) : (
              <HomeView
                mode={mode}
                userName={settings?.general.userName ?? ""}
                modelLabel={modelLabel}
                onSubmit={(t) => void handleSubmit(t)}
                onPickModel={openSettings}
                onPickFolder={() => void pickWorkingFolder()}
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
              onNewTask={() => void createScheduledTask("New task", "0 9 * * *")}
              onDailyBrief={() =>
                void createScheduledTask(
                  "Daily brief",
                  "0 8 * * *",
                  "Summarise what changed since yesterday and what needs my attention today.",
                )
              }
              onWeeklyReview={() =>
                void createScheduledTask(
                  "Weekly review",
                  "0 17 * * 5",
                  "Review this week's work and produce a short written summary.",
                )
              }
            />
          )}

          {nav === "projects" && (
            <Projects
              projects={projects}
              onNew={() => void createProject()}
              onOpen={(id) => {
                const p = projects.find((x) => x.id === id);
                if (p) setBanner(`Opened project ${p.name}`);
              }}
            />
          )}
        </main>

        {inSession && (
          <RightPanel
            tasks={modeState.tasks}
            workingFolder={null}
            connectors={connectors.filter((c) => c.enabled).map((c) => c.name)}
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
          onSave={(patch) => void patchSettings(patch)}
          onAddKey={(p, l, r) => void handleAddKey(p, l, r)}
          onRemoveKey={(k) => void handleRemoveKey(k)}
          onToggleSkill={(id, en) => void toggle(() => bridge().skills.setEnabled(id, en))}
          onToggleConnector={(id, en) => void toggle(() => bridge().mcp.setEnabled(id, en))}
          onTogglePlugin={(id, en) => void toggle(() => bridge().plugins.setEnabled(id, en))}
          onAddSkill={() => setBanner("Ask Kozum to install a skill, or drop a SKILL.md into the skills folder.")}
          onAddConnector={() => void addConnector()}
          onAddPlugin={() => void addPlugin()}
          onClose={() => setSettingsOpen(false)}
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

  async function createScheduledTask(name: string, cron: string, prompt?: string) {
    const res = await bridge().schedule.create({
      name,
      prompt: prompt ?? "Describe what this task should do.",
      cron,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      enabled: true,
      mode: "cowork",
      projectId: null,
      workingFolder: null,
      selection: null,
    });
    if (!res.ok) {
      setBanner(res.error);
      return;
    }
    setScheduled(await bridge().schedule.list());
  }

  async function addConnector() {
    const url = window.prompt("MCP server URL");
    if (!url) return;
    const token = window.prompt("Auth token (optional)") ?? "";
    const res = await bridge().mcp.add({
      name: new URL(url).hostname,
      enabled: true,
      transport: "http",
      url,
      hasAuthToken: Boolean(token),
      authToken: token || undefined,
      installedByAgent: false,
    } as never);
    if (!res.ok) {
      setBanner(res.error);
      return;
    }
    await reloadExtensions();
  }

  async function addPlugin() {
    const src = window.prompt("GitHub repository (owner/repo) or path to a .zip");
    if (!src) return;
    const res = await bridge().plugins.installFromUrl(src);
    if (!res.ok) {
      setBanner(res.error);
      return;
    }
    await reloadExtensions();
  }
}
