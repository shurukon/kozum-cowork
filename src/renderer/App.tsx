/**
 * Application shell.
 *
 * Owns only layout and the handful of pieces of state that are genuinely global
 * (mode, sidebar visibility, settings). Per-mode session state deliberately
 * lives one level down, because Cowork and Code must keep running
 * independently — switching tabs is a view change, never a teardown.
 */

import { useEffect, useState } from "react";

import type { AppSettings, Mode } from "@shared/types.ts";
import { TitleBar } from "./components/TitleBar.tsx";
import { Sidebar, type NavKey } from "./components/Sidebar.tsx";
import { HomeView } from "./components/HomeView.tsx";
import styles from "./App.module.css";

export function App() {
  const [mode, setMode] = useState<Mode>("cowork");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [nav, setNav] = useState<NavKey>("new");
  const [settings, setSettings] = useState<AppSettings | null>(null);

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
            onModeChange={setMode}
            active={nav}
            onNavigate={setNav}
            recents={[]}
            accountLabel={settings?.general.userName || "You"}
            providerLabel={selection?.providerId || "No provider"}
          />
        )}

        <main className={styles.content}>
          <HomeView
            mode={mode}
            userName={settings?.general.userName ?? ""}
            modelLabel={modelLabel}
            onSubmit={() => {
              /* wired to the agent loop in the next phase */
            }}
            onPickModel={() => setNav("customize")}
          />
        </main>
      </div>
    </div>
  );
}
