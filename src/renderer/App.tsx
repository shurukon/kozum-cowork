/**
 * Application shell.
 *
 * Owns only layout and the handful of pieces of state that are genuinely global
 * (mode, sidebar visibility, settings). Per-mode session state deliberately
 * lives one level down, because Cowork and Code must keep running
 * independently — switching tabs is a view change, never a teardown.
 */

import { useEffect, useState } from "react";

import type { AppSettings, Mode, Project, ScheduledTask } from "@shared/types.ts";
import { TitleBar } from "./components/TitleBar.tsx";
import { Sidebar, type NavKey } from "./components/Sidebar.tsx";
import { HomeView } from "./components/HomeView.tsx";
import { ChatView } from "./components/ChatView.tsx";
import { RightPanel } from "./components/RightPanel.tsx";
import { Settings } from "./components/Settings.tsx";
import { Scheduled } from "./pages/Scheduled.tsx";
import { Projects } from "./pages/Projects.tsx";
import { Artifacts } from "./pages/Artifacts.tsx";
import { useSessionStore } from "./store/session.ts";
import styles from "./App.module.css";

export function App() {
  const [mode, setMode] = useState<Mode>("cowork");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [nav, setNav] = useState<NavKey>("new");
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [projects] = useState<Project[]>([]);
  const [scheduled] = useState<ScheduledTask[]>([]);
  const [keepAwake, setKeepAwake] = useState(true);

  const modeState = useSessionStore((s) => s[mode]);

  useEffect(() => {
    void window.kozum?.settings.get().then(setSettings);
  }, []);

  // Language drives both the lang attribute and text direction. English is the
  // default; Arabic flips the whole shell to RTL via CSS logical properties.
  const lang = settings?.general.language ?? "en";
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
  }, [lang]);

  useEffect(() => {
    document.documentElement.dataset.motion = settings?.general.motion ?? "system";
  }, [settings?.general.motion]);

  const selection = settings?.[mode].selection;
  const modelLabel = selection?.modelId
    ? selection.modelId.split("/").pop()!
    : "Choose a model";

  const inSession = activeSessionId !== null && modeState.messages.length > 0;

  // Determine which nav key opens the chat vs. the home screen.
  function handleNavKey(key: NavKey) {
    setNav(key);
    if (key === "new") {
      setActiveSessionId(null);
    }
  }

  function handleSubmit(text: string) {
    // Optimistic: create a local session id and navigate to chat.
    const sid = `local-${Date.now()}`;
    setActiveSessionId(sid);
    // In a real wiring, we'd call bridge().sessions.send() here.
    // For now we just add the user message optimistically.
    const { addUserMessage } = useSessionStore.getState();
    addUserMessage(mode, {
      id: `msg-user-${Date.now()}`,
      role: "user",
      content: [{ type: "text", text }],
      createdAt: Date.now(),
    });
  }

  function handleSaveSettings(patch: Partial<AppSettings>) {
    if (!settings) return;
    setSettings({ ...settings, ...patch } as AppSettings);
    void window.kozum?.settings.set(patch);
  }

  return (
    <div className={styles.app}>
      <TitleBar
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        sidebarOpen={sidebarOpen}
      />

      <div className={styles.body}>
        {sidebarOpen && (
          <Sidebar
            mode={mode}
            onModeChange={(m) => {
              setMode(m);
              setNav("new");
              setActiveSessionId(null);
            }}
            active={nav}
            onNavigate={handleNavKey}
            recents={[]}
            accountLabel={settings?.general.userName || "You"}
            providerLabel={selection?.providerId || "No provider"}
          />
        )}

        <main className={styles.content}>
          {nav === "new" && (
            inSession ? (
              <ChatView
                mode={mode}
                sessionId={activeSessionId!}
                onSend={handleSubmit}
                onCancel={() => {/* wire to bridge().sessions.cancel() */}}
                onPickModel={() => setNav("customize")}
                modelLabel={modelLabel}
              />
            ) : (
              <HomeView
                mode={mode}
                userName={settings?.general.userName ?? ""}
                modelLabel={modelLabel}
                onSubmit={handleSubmit}
                onPickModel={() => setNav("customize")}
              />
            )
          )}

          {nav === "scheduled" && (
            <Scheduled
              tasks={scheduled}
              keepAwake={keepAwake}
              onToggleKeepAwake={() => {
                setKeepAwake((v) => !v);
                if (settings) {
                  void window.kozum?.settings.set({
                    scheduler: { ...settings.scheduler, keepAwake: !keepAwake },
                  });
                }
              }}
              onNewTask={() => {/* open new task form */}}
              onDailyBrief={() => {/* create daily brief task */}}
              onWeeklyReview={() => {/* create weekly review task */}}
            />
          )}

          {nav === "projects" && (
            <Projects
              projects={projects}
              onNew={() => {/* open new project form */}}
              onOpen={(_id) => {/* open project view */}}
            />
          )}

          {nav === "artifacts" && (
            <Artifacts
              artifacts={[]}
              onOpen={(_id) => {/* open artifact */}}
            />
          )}

          {nav === "customize" && (
            <HomeView
              mode={mode}
              userName={settings?.general.userName ?? ""}
              modelLabel={modelLabel}
              onSubmit={handleSubmit}
              onPickModel={() => setSettingsOpen(true)}
            />
          )}
        </main>

        {/* Right panel — only shown during an active session */}
        {inSession && (
          <RightPanel
            tasks={modeState.tasks}
            workingFolder={null}
            connectors={[]}
          />
        )}
      </div>

      {/* Settings modal */}
      {settingsOpen && settings && (
        <Settings
          settings={settings}
          presets={[]}
          keys={{}}
          skills={[]}
          connectors={[]}
          plugins={[]}
          onSave={handleSaveSettings}
          onAddKey={(_providerId, _label, _raw) => {/* wire bridge */}}
          onRemoveKey={(_keyId) => {/* wire bridge */}}
          onToggleSkill={(_id, _enabled) => {/* wire bridge */}}
          onToggleConnector={(_id, _enabled) => {/* wire bridge */}}
          onTogglePlugin={(_id, _enabled) => {/* wire bridge */}}
          onAddSkill={() => {/* open add-skill flow */}}
          onAddConnector={() => {/* open add-connector flow */}}
          onAddPlugin={() => {/* open add-plugin flow */}}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
