/**
 * Kozum Cowork — preload bridge.
 *
 * The renderer gets an explicit, hand-written API surface and nothing else.
 * No `ipcRenderer` passthrough, no `require`, no Node globals: every capability
 * the UI has is a named method here, which keeps the audit surface small even
 * though the main process can drive the entire machine.
 *
 * onEvent / onState return unsubscribe functions whose bodies are braced so they
 * return void. ipcRenderer.off() returns IpcRenderer, which is incompatible with
 * React's EffectCallback (which requires void). The braced form prevents that.
 */

import { contextBridge, ipcRenderer } from "electron";
import type {
  AppSettings,
  ProviderPreset,
  ApiKeyEntry,
  ModelInfo,
  ModelSelection,
  Session,
  Message,
  AgentEvent,
  AgentTask,
  ScheduledTask,
  McpServerConfig,
  McpToolInfo,
  Plugin,
  Project,
  Skill,
  Result,
  Mode,
} from "../shared/types.ts";
import type { CreateProjectInput, UpdateProjectPatch } from "../main/store/projects.ts";

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
    addKey: (
      providerId: string,
      label: string,
      rawKey: string,
      meta?: Record<string, string>,
    ): Promise<Result<ApiKeyEntry>> =>
      ipcRenderer.invoke("providers:addKey", providerId, label, rawKey, meta),
    removeKey: (keyId: string): Promise<Result<void>> =>
      ipcRenderer.invoke("providers:removeKey", keyId),
    listKeys: (providerId: string): Promise<ApiKeyEntry[]> =>
      ipcRenderer.invoke("providers:listKeys", providerId),
    testKey: (keyId: string): Promise<Result<void>> =>
      ipcRenderer.invoke("providers:testKey", keyId),
    refreshModels: (providerId: string): Promise<Result<ModelInfo[]>> =>
      ipcRenderer.invoke("providers:refreshModels", providerId),
    listModels: (providerId: string): Promise<ModelInfo[]> =>
      ipcRenderer.invoke("providers:listModels", providerId),
  },

  sessions: {
    list: (mode: Mode): Promise<Session[]> => ipcRenderer.invoke("sessions:list", mode),
    get: (sessionId: string): Promise<Session | null> =>
      ipcRenderer.invoke("sessions:get", sessionId),
    create: (mode: Mode, selection: ModelSelection): Promise<Result<Session>> =>
      ipcRenderer.invoke("sessions:create", mode, selection),
    archive: (sessionId: string): Promise<Result<void>> =>
      ipcRenderer.invoke("sessions:archive", sessionId),
    messages: (sessionId: string): Promise<Message[]> =>
      ipcRenderer.invoke("sessions:messages", sessionId),
    send: (sessionId: string, text: string, attachments?: string[]): Promise<Result<void>> =>
      ipcRenderer.invoke("sessions:send", sessionId, text, attachments),
    cancel: (sessionId: string): Promise<Result<void>> =>
      ipcRenderer.invoke("sessions:cancel", sessionId),
    reply: (
      sessionId: string,
      requestId: string,
      answer: string | string[],
    ): Promise<Result<void>> =>
      ipcRenderer.invoke("sessions:reply", sessionId, requestId, answer),
    tasks: (sessionId: string): Promise<AgentTask[]> =>
      ipcRenderer.invoke("sessions:tasks", sessionId),
    /**
     * Subscribe to agent events for any session.
     * Returns an unsubscribe function. The body is braced deliberately:
     * ipcRenderer.off() returns IpcRenderer, and leaking that return value
     * makes the function incompatible with React's EffectCallback.
     */
    onEvent: (cb: (e: AgentEvent) => void): (() => void) => {
      const handler = (_event: unknown, e: AgentEvent) => cb(e);
      ipcRenderer.on("sessions:event", handler);
      return () => {
        ipcRenderer.off("sessions:event", handler);
      };
    },
  },

  schedule: {
    list: (): Promise<ScheduledTask[]> => ipcRenderer.invoke("schedule:list"),
    create: (
      task: Omit<ScheduledTask, "id" | "createdAt" | "runCount">,
    ): Promise<Result<ScheduledTask>> => ipcRenderer.invoke("schedule:create", task),
    update: (
      id: string,
      patch: Partial<ScheduledTask>,
    ): Promise<Result<ScheduledTask>> =>
      ipcRenderer.invoke("schedule:update", id, patch),
    remove: (id: string): Promise<Result<void>> => ipcRenderer.invoke("schedule:remove", id),
  },

  mcp: {
    list: (): Promise<McpServerConfig[]> => ipcRenderer.invoke("mcp:list"),
    add: (
      config: Omit<McpServerConfig, "id" | "createdAt" | "status" | "toolCount">,
    ): Promise<Result<McpServerConfig>> => ipcRenderer.invoke("mcp:add", config),
    remove: (id: string): Promise<Result<void>> => ipcRenderer.invoke("mcp:remove", id),
    setEnabled: (id: string, enabled: boolean): Promise<Result<void>> =>
      ipcRenderer.invoke("mcp:setEnabled", id, enabled),
    tools: (serverId: string): Promise<McpToolInfo[]> =>
      ipcRenderer.invoke("mcp:tools", serverId),
  },

  plugins: {
    list: (): Promise<Plugin[]> => ipcRenderer.invoke("plugins:list"),
    setEnabled: (id: string, enabled: boolean): Promise<Result<void>> =>
      ipcRenderer.invoke("plugins:setEnabled", id, enabled),
    remove: (id: string): Promise<Result<void>> => ipcRenderer.invoke("plugins:remove", id),
    installFromUrl: (url: string): Promise<Result<Plugin>> =>
      ipcRenderer.invoke("plugins:installFromUrl", url),
  },

  skills: {
    list: (): Promise<Skill[]> => ipcRenderer.invoke("skills:list"),
    setEnabled: (id: string, enabled: boolean): Promise<Result<void>> =>
      ipcRenderer.invoke("skills:setEnabled", id, enabled),
  },

  dialog: {
    /** Open a native folder picker. Resolves to the chosen path, or null if cancelled. */
    selectFolder: (): Promise<string | null> => ipcRenderer.invoke("dialog:selectFolder"),
    /** Open a native file picker (multi-select). Resolves to the chosen paths (may be empty). */
    selectFiles: (): Promise<string[]> => ipcRenderer.invoke("dialog:selectFiles"),
  },

  projects: {
    list: (): Promise<Project[]> => ipcRenderer.invoke("projects:list"),
    create: (input: CreateProjectInput): Promise<Result<Project>> =>
      ipcRenderer.invoke("projects:create", input),
    update: (id: string, patch: UpdateProjectPatch): Promise<Result<Project>> =>
      ipcRenderer.invoke("projects:update", id, patch),
    archive: (id: string): Promise<Result<Project>> =>
      ipcRenderer.invoke("projects:archive", id),
    remove: (id: string): Promise<Result<void>> =>
      ipcRenderer.invoke("projects:remove", id),
  },

  window: {
    minimize: () => ipcRenderer.send("window:minimize"),
    maximize: () => ipcRenderer.send("window:maximize"),
    close: () => ipcRenderer.send("window:close"),
    /**
     * Returns an unsubscribe function so React effects can clean up.
     * The body is braced deliberately: ipcRenderer.off() returns IpcRenderer,
     * and leaking that return value makes the function incompatible with
     * React's EffectCallback, which demands void.
     */
    onState: (cb: (s: WindowState) => void): (() => void) => {
      const handler = (_e: unknown, s: WindowState) => cb(s);
      ipcRenderer.on("window:state", handler);
      return () => {
        ipcRenderer.off("window:state", handler);
      };
    },
  },
} as const;

export type KozumApi = typeof api;

contextBridge.exposeInMainWorld("kozum", api);
