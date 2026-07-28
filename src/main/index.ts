/**
 * Kozum Cowork — Electron main process.
 *
 * Runs directly on Windows. There is no Linux VM, no WSL and no bundled distro:
 * the tools in src/main/tools execute against the host filesystem and shell,
 * which is the whole reason this app exists as an alternative to the reference
 * product's ~12GB Hyper-V image.
 */

import { app, BrowserWindow, ipcMain, nativeTheme, shell } from "electron";
import { join } from "node:path";
import { existsSync } from "node:fs";

import { freshSettings } from "../shared/defaults.ts";
import { PROVIDER_PRESETS } from "./providers/presets.ts";
import type { AppSettings } from "../shared/types.ts";

const isDev = !app.isPackaged;

/**
 * Windows data dir. Deliberately NOT the reference product's `Claude-3p` path
 * shape, and deliberately tolerant of symlinks/junctions: OneDrive folder
 * redirection turns %LOCALAPPDATA% into a junction on a lot of machines, and
 * refusing to traverse it is exactly the failure users hit elsewhere.
 */
function resolveUserData(): string {
  const dir = join(app.getPath("appData"), "Kozum");
  return dir;
}

let mainWindow: BrowserWindow | null = null;

/** In-memory settings; the persistent store lands in a later phase. */
let settings: AppSettings = freshSettings();

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
  const pushWindowState = () =>
    mainWindow?.webContents.send("window:state", {
      maximized: mainWindow.isMaximized(),
      focused: mainWindow.isFocused(),
    });
  for (const ev of ["maximize", "unmaximize", "focus", "blur"] as const) {
    mainWindow.on(ev, pushWindowState);
  }

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (isDev && devUrl) {
    void mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    const html = join(import.meta.dirname, "../renderer/index.html");
    if (existsSync(html)) void mainWindow.loadFile(html);
  }
}

/* ---------------------------------------------------------------- IPC --- */

function registerIpc(): void {
  ipcMain.handle("app:info", () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    userDataPath: resolveUserData(),
    isDev,
  }));

  ipcMain.handle("settings:get", () => settings);

  ipcMain.handle("settings:set", (_e, patch: Partial<AppSettings>) => {
    settings = { ...settings, ...patch };
    return settings;
  });

  ipcMain.handle("providers:presets", () => PROVIDER_PRESETS);

  ipcMain.on("window:minimize", () => mainWindow?.minimize());
  ipcMain.on("window:maximize", () => {
    if (!mainWindow) return;
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  });
  ipcMain.on("window:close", () => mainWindow?.close());
}

/* -------------------------------------------------------------- boot ---- */

// One instance only; a second launch focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId("app.kozum.cowork");
    nativeTheme.themeSource = "dark";

    registerIpc();
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
