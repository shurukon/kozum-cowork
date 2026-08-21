/**
 * Kozum Cowork — Electron main process.
 *
 * Runs directly on Windows. There is no Linux VM, no WSL and no bundled distro:
 * the tools in src/main/tools execute against the host filesystem and shell,
 * which is the whole reason this app exists as an alternative to the reference
 * product's ~12GB Hyper-V image.
 */

import { app, BrowserWindow, dialog, ipcMain, nativeTheme, safeStorage, shell } from "electron";
import { join } from "node:path";
import { existsSync } from "node:fs";

import { settingsPath, keysPath, sessionsDir, memoryDir, pluginsDir, projectsPath } from "./store/paths.ts";
import { ProjectStore } from "./store/projects.ts";
import { SettingsStore } from "./store/settings.ts";
import { SecretStore } from "./store/secrets.ts";
import { ProviderRegistry } from "./providers/registry.ts";
import { SessionStore } from "./session/store.ts";
import { SessionManager } from "./session/manager.ts";
import { MemoryVault } from "./memory/vault.ts";
import { SkillStore } from "./skills/index.ts";
import { Scheduler } from "./schedule/scheduler.ts";
import { McpManager } from "./mcp/manager.ts";
import { PluginManager } from "./plugins/manager.ts";
import { BrowserEngine, ElectronBrowserBackend } from "./browser/engine.ts";
import { BrowserSurface } from "./browser/surface.ts";
import { TaskStore } from "./tools/tasks.ts";
import { AskBroker } from "./tools/ask.ts";
import { SubagentManager } from "./agent/subagents.ts";
import { makeRealRunner } from "./agent/subagentRunner.ts";
import { buildToolRegistry } from "./tools/index.ts";
import { registerIpc, makeEmitEvent } from "./ipc/index.ts";
import type { Mode } from "../shared/types.ts";

const isDev = !app.isPackaged;

// Electron's Linux keychain is unavailable in the headless test sandbox. Keep
// the live UI harness real while ensuring this opt-in behavior is impossible
// in packaged/production runs and is confined to the ephemeral test profile.
if (process.env.NODE_ENV === "test" && process.env.KOZUM_USERDATA) {
  safeStorage.setUsePlainTextEncryption(true);
}

/**
 * Windows data dir. Deliberately NOT the reference product's `Claude-3p` path
 * shape, and deliberately tolerant of symlinks/junctions: OneDrive folder
 * redirection turns %LOCALAPPDATA% into a junction on a lot of machines, and
 * refusing to traverse it is exactly the failure users hit elsewhere.
 */
function resolveUserData(): string {
  const testOverride = process.env.KOZUM_USERDATA?.trim();
  if (process.env.NODE_ENV === "test" && testOverride) return testOverride;
  return join(app.getPath("appData"), "Kozum");
}

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 940,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    // Frameless with our own title bar, matching the reference app's chrome.
    frame: false,
    titleBarStyle: "hidden",
    // Paint the shell colour immediately so there is no white flash on launch.
    backgroundColor: "#05081A",
    icon: join(app.getAppPath(), "build", "icon.ico"),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.mjs"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // The internal browser and artifact preview run in separate
      // WebContentsViews with their own hardened settings.
      webviewTag: false,
      spellcheck: false,
    },
  });

  mainWindow.on("ready-to-show", () => mainWindow?.show());

  // Anything trying to open a new window goes to the OS browser instead.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  // Keep the renderer's maximised state in sync with the real window.
  const pushWindowState = () => {
    if (!mainWindow) return;
    mainWindow.webContents.send("window:state", {
      maximized: mainWindow.isMaximized(),
      focused: mainWindow.isFocused(),
    });
  };
  // Registered individually rather than in a loop: BrowserWindow.on is typed as
  // a set of per-event overloads, so a union of event names matches none of them.
  mainWindow.on("maximize", pushWindowState);
  mainWindow.on("unmaximize", pushWindowState);
  mainWindow.on("focus", pushWindowState);
  mainWindow.on("blur", pushWindowState);

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (isDev && devUrl) {
    void mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    const html = join(import.meta.dirname, "../renderer/index.html");
    if (existsSync(html)) void mainWindow.loadFile(html);
  }
}

/* ---------------------------------------------------------------- boot ---- */

// One instance only; a second launch focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId("app.kozum.cowork");
    nativeTheme.themeSource = "dark";

    const userDataPath = resolveUserData();
    const appPaths = { getPath: (_name: "appData") => userDataPath };

    // ── stores ──────────────────────────────────────────────────────────────
    const settings = new SettingsStore(settingsPath(appPaths));
    const projects = new ProjectStore(projectsPath(appPaths));
    const secrets = new SecretStore(keysPath(appPaths), {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (s: string) => safeStorage.encryptString(s),
      decryptString: (buf: Buffer) => safeStorage.decryptString(buf),
    });

    // ── providers ───────────────────────────────────────────────────────────
    const registry = new ProviderRegistry(secrets, appPaths, async () => {
      const current = await settings.get();
      return Array.isArray(current.customProviders) ? current.customProviders : [];
    });

    // ── sessions ────────────────────────────────────────────────────────────
    const sessionStore = new SessionStore(sessionsDir(appPaths));

    // ── memory ──────────────────────────────────────────────────────────────
    let memory: MemoryVault;
    try {
      memory = new MemoryVault(memoryDir(appPaths));
      await memory.init();
    } catch (e) {
      console.error("[boot] Memory vault init failed:", e);
      memory = new MemoryVault(memoryDir(appPaths));
    }

    // ── skills ──────────────────────────────────────────────────────────────
    // SkillStore and its tools remain fully available, but bundled skills are
    // intentionally opt-in. A fresh Kozum install must start with an empty
    // Skills catalogue; user-provided skills in the legacy app-level directory
    // are still discovered for backwards compatibility.
    const skills = new SkillStore();
    try {
      const legacySkillsDir = join(app.getAppPath(), "skills");
      if (existsSync(legacySkillsDir)) {
        await skills.discover([legacySkillsDir]);
      }
    } catch (e) {
      console.error("[boot] Skill discovery failed:", e);
    }

    // ── task / ask stores ────────────────────────────────────────────────────
    // IPC keeps this map updated for session lifecycle calls; TaskStore also
    // records the mode before every task mutation for supervisor-created tasks.
    const sessionModes = new Map<string, Mode>();
    let tasks: TaskStore;
    tasks = new TaskStore((sessionId, taskList) => {
      emitEvent(sessionId, {
        type: "task_update",
        mode: tasks.modeFor(sessionId) ?? "cowork",
        sessionId,
        tasks: taskList,
      });
    });
    const ask = new AskBroker();

    // ── subagent manager ─────────────────────────────────────────────────────
    // Declare the manager with a stub runner first. The real runner needs the
    // provider registry + SettingsStore + tool registry to run a real loop, and
    // those are not all constructed yet at this point. After SessionManager is
    // built (see below) we call subagents.setRunner(makeRealRunner({...})) —
    // the deferred-construction pattern used by the scheduler too.
    const subagents = new SubagentManager(
      async (_spec) => ({ text: "(subagent not yet wired)" }),
      4,
      tasks,
    );

    // ── mcp ─────────────────────────────────────────────────────────────────
    const mcp = new McpManager();
    try {
      await mcp.connectAll();
    } catch (e) {
      console.error("[boot] MCP connectAll failed:", e);
    }

    // ── plugins ─────────────────────────────────────────────────────────────
    // PluginManager, plugin tools, IPC, and user installation remain active.
    // Bundled plugins are not registered automatically so a fresh installation
    // exposes an empty Plugins catalogue rather than pre-installed entries.
    const plugins = new PluginManager(pluginsDir(appPaths));
    try {
      await plugins.list();
    } catch (e) {
      console.error("[boot] Plugin load failed:", e);
    }

    // ── browser ─────────────────────────────────────────────────────────────
    const browserBackend = new ElectronBrowserBackend();
    const browser = new BrowserEngine(browserBackend);
    const browserSurface = new BrowserSurface();

    // ── event forwarding ─────────────────────────────────────────────────────
    const emitEvent = makeEmitEvent(() => mainWindow);

    // ── scheduler ───────────────────────────────────────────────────────────
    // The scheduler runner needs sessionManager, but sessionManager needs the
    // tool registry. Build a placeholder runner first, then wire the real one.
    let sessionManagerRef: SessionManager | null = null;

    const scheduler = new Scheduler({
      rootDir: userDataPath,
      runner: async (scheduledTask) => {
        if (!sessionManagerRef) {
          throw new Error("Scheduler session manager is not ready");
        }
        const appSets = await settings.get();
        const modeSettings = appSets[scheduledTask.mode];
        const selection = scheduledTask.selection ?? modeSettings.selection;
        const session = await sessionStore.create(scheduledTask.mode, selection);
        await sessionManagerRef.send(session.id, scheduledTask.prompt);
      },
    });

    // ── tool registry ────────────────────────────────────────────────────────
    const toolRegistry = buildToolRegistry({
      tasks,
      ask,
      subagents,
      skills,
      memory,
      scheduler,
      mcp,
      plugins,
      browser,
      getComputerBlocklist: () => [],
    });

    // ── session manager ──────────────────────────────────────────────────────
    const sessionManager = new SessionManager({
      sessions: sessionStore,
      registry,
      settings,
      memory,
      skills,
      mcp,
      ask,
      tasks,
      toolRegistry,
      emitEvent,
    });

    // Patch the circular reference so the scheduler can create sessions.
    // Start only after this assignment: startup catch-up runs must never be
    // silently discarded because the session manager is not ready yet.
    sessionManagerRef = sessionManager;
    try {
      await scheduler.start();
    } catch (e) {
      console.error("[boot] Scheduler start failed:", e);
    }

    // Bridge subagent lifecycle events back to the parent session's renderer so
    // the UI can show a live "Active subagents" card (P1-1 / D1).
    subagents.setEmitter((sessionId, e) => emitEvent(sessionId, e));

    // Replace the subagent stub with a real runner now that the provider
    // registry, settings store, and tool registry all exist. Subagent runs are
    // fire-and-forget; the manager forwards subagent_* events to the parent.
    subagents.setRunner(
      makeRealRunner({
        registry,
        settings,
        memory,
        skills,
        mcp,
        toolRegistry,
        // The runner reports per-tool progress; the manager turns it into a
        // subagent_progress event for the parent renderer.
        bumpProgress: (runId, note, progress) =>
          subagents.bumpProgress(runId, note, progress),
      }),
    );

    // ── IPC ─────────────────────────────────────────────────────────────────
    registerIpc({
      ipcMain,
      app,
      getWindow: () => mainWindow,
      isDev,
      userDataPath,
      settings,
      secrets,
      registry,
      sessions: sessionStore,
      sessionManager,
      scheduler,
      mcp,
      plugins,
      skills,
      tasks,
      projects,
      memory,
      // Electron types `properties` as a literal union rather than string[],
      // so the Dialog object is not structurally assignable to DialogFacade.
      // Adapt it here instead of loosening the facade.
      dialog: {
        showOpenDialog: (options: { properties: string[] }) =>
          dialog.showOpenDialog({
            properties: options.properties as Array<
              "openFile" | "openDirectory" | "multiSelections" | "createDirectory"
            >,
          }),
      },
      sessionModes,
      browserSurface,
      subagents,
      getBrowserView: () => browserBackend.getWebContentsView(),
      getBrowserScreenshot: (opts) => browser.screenshot(opts),
    });

    // ── window chrome IPC ────────────────────────────────────────────────────
    ipcMain.on("window:minimize", () => mainWindow?.minimize());
    ipcMain.on("window:maximize", () => {
      if (!mainWindow) return;
      mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
    });
    ipcMain.on("window:close", () => mainWindow?.close());

    // ── window ───────────────────────────────────────────────────────────────
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
