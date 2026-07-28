/**
 * Kozum Cowork — preload bridge.
 *
 * The renderer gets an explicit, hand-written API surface and nothing else.
 * No `ipcRenderer` passthrough, no `require`, no Node globals: every capability
 * the UI has is a named method here, which keeps the audit surface small even
 * though the main process can drive the entire machine.
 */

import { contextBridge, ipcRenderer } from "electron";
import type { AppSettings, ProviderPreset } from "../shared/types.ts";

export interface AppInfo {
  version: string;
  platform: string;
  arch: string;
  electron: string;
  node: string;
  chrome: string;
  userDataPath: string;
  isDev: boolean;
}

export interface WindowState {
  maximized: boolean;
  focused: boolean;
}

const api = {
  app: {
    info: (): Promise<AppInfo> => ipcRenderer.invoke("app:info"),
  },

  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke("settings:get"),
    set: (patch: Partial<AppSettings>): Promise<AppSettings> =>
      ipcRenderer.invoke("settings:set", patch),
  },

  providers: {
    presets: (): Promise<ProviderPreset[]> => ipcRenderer.invoke("providers:presets"),
  },

  window: {
    minimize: () => ipcRenderer.send("window:minimize"),
    maximize: () => ipcRenderer.send("window:maximize"),
    close: () => ipcRenderer.send("window:close"),
    /** Returns an unsubscribe function so React effects can clean up. */
    onState: (cb: (s: WindowState) => void) => {
      const handler = (_e: unknown, s: WindowState) => cb(s);
      ipcRenderer.on("window:state", handler);
      return () => ipcRenderer.off("window:state", handler);
    },
  },
} as const;

export type KozumApi = typeof api;

contextBridge.exposeInMainWorld("kozum", api);
