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
  PermissionMode,
  ProviderPreset,
  ApiKeyEntry,
  ModelInfo,
  ModelSelection,
  Session,
  Message,
  AgentEvent,
  AgentTask,
  ScheduledTask,
  McpConnectionTest,
  McpServerConfig,
  McpToolInfo,
  Plugin,
  Project,
  Skill,
  Result,
  Mode,
} from "../shared/types.ts";
import type { CreateProjectInput, UpdateProjectPatch } from "../main/store/projects.ts";
import type { RunSummary } from "../main/session/store.ts";

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
    refreshModels: (
      providerId: string,
    ): Promise<Result<{ models: ModelInfo[]; warning: string | null }>> =>
      ipcRenderer.invoke("providers:refreshModels", providerId),
    listModels: (providerId: string): Promise<ModelInfo[]> =>
      ipcRenderer.invoke("providers:listModels", providerId),
    addCustom: (input: {
      name: string;
      baseUrl: string;
      protocol?: "openai-chat" | "openai-responses" | "anthropic-messages";
      modelIds?: string[];
      /** Raw key registered for the new provider in the same call. */
      apiKey?: string;
    }): Promise<Result<ProviderPreset>> =>
      ipcRenderer.invoke("providers:addCustom", input),
    removeCustom: (id: string): Promise<Result<void>> =>
      ipcRenderer.invoke("providers:removeCustom", id),
    updateCustom: (id: string, patch: Partial<ProviderPreset>): Promise<Result<ProviderPreset>> =>
      ipcRenderer.invoke("providers:updateCustom", id, patch),
  },

  sessions: {
    list: (mode: Mode): Promise<Session[]> => ipcRenderer.invoke("sessions:list", mode),
    get: (sessionId: string): Promise<Session | null> =>
      ipcRenderer.invoke("sessions:get", sessionId),
    create: (mode: Mode, selection: ModelSelection): Promise<Result<Session>> =>
      ipcRenderer.invoke("sessions:create", mode, selection),
    archive: (sessionId: string): Promise<Result<void>> =>
      ipcRenderer.invoke("sessions:archive", sessionId),
    delete: (sessionId: string): Promise<Result<void>> =>
      ipcRenderer.invoke("sessions:delete", sessionId),
    branch: (sessionId: string, uptoMessageId?: string | null): Promise<Result<Session>> =>
      ipcRenderer.invoke("sessions:branch", sessionId, uptoMessageId),
    rename: (sessionId: string, title: string): Promise<Result<void>> =>
      ipcRenderer.invoke("sessions:rename", sessionId, title),
    setPermissionMode: (sessionId: string, mode: PermissionMode): Promise<Result<void>> =>
      ipcRenderer.invoke("sessions:setPermissionMode", sessionId, mode),
    messages: (sessionId: string): Promise<Message[]> =>
      ipcRenderer.invoke("sessions:messages", sessionId),
    send: (
      sessionId: string,
      text: string,
      attachments?: string[],
      clientTurnId?: string,
    ): Promise<Result<void>> =>
      ipcRenderer.invoke("sessions:send", sessionId, text, attachments, clientTurnId),
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
    /** Reattach a refresh-interrupted run; replays the persisted event stream. */
    reattach: (
      sessionId: string,
      sinceRunId?: string,
    ): Promise<{ runId?: string; events: AgentEvent[]; done: boolean }> =>
      ipcRenderer.invoke("sessions:reattach", sessionId, sinceRunId),
    /** List persisted runs for a session (P2 "Runs" panel). */
    listRuns: (sessionId: string): Promise<RunSummary[]> =>
      ipcRenderer.invoke("sessions:listRuns", sessionId),
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
    runNow: (id: string): Promise<Result<void>> => ipcRenderer.invoke("schedule:runNow", id),
  },

  mcp: {
    list: (): Promise<McpServerConfig[]> => ipcRenderer.invoke("mcp:list"),
    testConnection: (
      config: Omit<McpServerConfig, "id" | "createdAt" | "status" | "toolCount"> & { authToken?: string },
    ): Promise<Result<McpConnectionTest>> => ipcRenderer.invoke("mcp:testConnection", config),
    add: (
      config: Omit<McpServerConfig, "id" | "createdAt" | "status" | "toolCount"> & { authToken?: string },
    ): Promise<Result<McpServerConfig>> => ipcRenderer.invoke("mcp:add", config),
    remove: (id: string): Promise<Result<void>> => ipcRenderer.invoke("mcp:remove", id),
    setEnabled: (id: string, enabled: boolean): Promise<Result<void>> =>
      ipcRenderer.invoke("mcp:setEnabled", id, enabled),
    tools: (serverId: string): Promise<McpToolInfo[]> =>
      ipcRenderer.invoke("mcp:tools", serverId),
    /** Replace a connector's per-tool execution policy (merged server-side). */
    setToolPolicy: (
      serverId: string,
      policy: { default: "allow" | "deny" | "ask"; tools?: Record<string, "allow" | "deny" | "ask"> },
    ): Promise<Result<McpServerConfig>> =>
      ipcRenderer.invoke("mcp:setToolPolicy", serverId, policy),
  },

  plugins: {
    list: (): Promise<Plugin[]> => ipcRenderer.invoke("plugins:list"),
    setEnabled: (id: string, enabled: boolean): Promise<Result<void>> =>
      ipcRenderer.invoke("plugins:setEnabled", id, enabled),
    remove: (id: string): Promise<Result<void>> => ipcRenderer.invoke("plugins:remove", id),
    installFromUrl: (url: string): Promise<Result<Plugin>> =>
      ipcRenderer.invoke("plugins:installFromUrl", url),
    installFromZip: (path: string): Promise<Result<Plugin>> =>
      ipcRenderer.invoke("plugins:installFromZip", path),
  },

  skills: {
    list: (): Promise<Skill[]> => ipcRenderer.invoke("skills:list"),
    setEnabled: (id: string, enabled: boolean): Promise<Result<void>> =>
      ipcRenderer.invoke("skills:setEnabled", id, enabled),
    /** Install a skill folder/SKILL.md/.md into the userData root, then rescan. */
    add: (sourcePath: string): Promise<Result<Skill[]>> =>
      ipcRenderer.invoke("skills:add", sourcePath),
    /** Remove a user-installed skill (bundled/legacy entries are refused). */
    remove: (id: string): Promise<Result<void>> =>
      ipcRenderer.invoke("skills:remove", id),
  },

  subagents: {
    cancel: (runId: string): Promise<Result<void>> =>
      ipcRenderer.invoke("subagents:cancel", runId),
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

  memory: {
    getRules: (): Promise<Result<string>> => ipcRenderer.invoke("memory:getRules"),
    setRules: (text: string): Promise<Result<void>> => ipcRenderer.invoke("memory:setRules", text),
  },

  preview: {
    /**
     * Read a file for inline preview. Returns text content or base64 for images.
     * Text is capped at ~512 KB (truncated=true when the file was larger).
     */
    readFile: (path: string): Promise<Result<{
      content: string;
      base64?: string;
      mime: string;
      truncated: boolean;
    }>> => ipcRenderer.invoke("preview:readFile", path),

    /** Stat a file — size in bytes, isDir flag. */
    stat: (path: string): Promise<Result<{ size: number; isDir: boolean }>> =>
      ipcRenderer.invoke("preview:stat", path),

    /** Open a preview file externally, reveal it, or launch it in the configured IDE. */
    open: (path: string, action: "external" | "reveal" | "ide" = "external"): Promise<Result<void>> =>
      ipcRenderer.invoke("preview:open", path, action),

    /** Serve local HTML through the hardened loopback preview and navigate Chromium to it. */
    openLiveHtml: (path: string): Promise<Result<{ url: string; path: string }>> =>
      ipcRenderer.invoke("preview:openLiveHtml", path),
  },

  browser: {
    /**
     * Attach the agent's live WebContentsView to the app window at the given
     * screen rect (in renderer CSS pixels). Returns the current browser state.
     * Returns {ok:false} when no browser session exists yet or the surface is
     * unavailable.
     */
    attach: (
      rect: { x: number; y: number; width: number; height: number },
      sessionId?: string,
    ): Promise<Result<{
      currentUrl: string;
      title: string;
      isLoading: boolean;
      attached: boolean;
    }>> => ipcRenderer.invoke("browser:attach", rect, sessionId),

    /** Detach the live view from the window (preview closed). */
    detach: (): Promise<Result<void>> => ipcRenderer.invoke("browser:detach"),

    /** Poll the current browser state (url, title, loading, attached). */
    state: (): Promise<{
      currentUrl: string;
      title: string;
      isLoading: boolean;
      attached: boolean;
    }> => ipcRenderer.invoke("browser:state"),

    /** Capture the actual agent-controlled Chromium view. */
    screenshot: (opts?: { fullPage?: boolean; quality?: number }): Promise<Result<{
      data: string;
      mimeType: "image/jpeg";
      width: number;
      height: number;
    }>> => ipcRenderer.invoke("browser:screenshot", opts),

    /** Update only the rect of the already-attached view (on resize). */
    updateBounds: (
      rect: { x: number; y: number; width: number; height: number },
    ): Promise<{
      currentUrl: string;
      title: string;
      isLoading: boolean;
      attached: boolean;
    }> => ipcRenderer.invoke("browser:updateBounds", rect),
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
