/**
 * Kozum Cowork — typed bridge to the preload API.
 *
 * The preload exposes window.kozum with the four channels that exist today.
 * Additional channels (sessions, events, keys, models, mcp, plugins, schedule)
 * will be added to the preload by the main-process team; we declare their
 * shapes here so the renderer compiles against the full contract now, and
 * every call site goes through bridge() so a missing method surfaces as a
 * clear runtime error rather than a silent undefined.
 *
 * DO NOT edit src/preload/index.ts — this file is the contract declaration only.
 */

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
  McpServerConfig,
  McpToolInfo,
  Plugin,
  Project,
  Skill,
  Result,
  Mode,
  RunSummary,
} from "@shared/types.ts";

// Re-export the types already declared in preload so bridge consumers have
// one import path.
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

// ── Full bridge surface ────────────────────────────────────────────────────

export interface KozumBridge {
  app: {
    info: () => Promise<AppInfo>;
  };

  settings: {
    get: () => Promise<AppSettings>;
    set: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  };

  providers: {
    presets: () => Promise<ProviderPreset[]>;
    /** Add a new API key. Label is optional; defaults to "Key N". */
    addKey: (
      providerId: string,
      label: string,
      rawKey: string,
      meta?: Record<string, string>,
    ) => Promise<Result<ApiKeyEntry>>;
    removeKey: (keyId: string) => Promise<Result<void>>;
    listKeys: (providerId: string) => Promise<ApiKeyEntry[]>;
    /** Probe connectivity and update key.status. */
    testKey: (keyId: string) => Promise<Result<void>>;
    /** Fetch models from the provider's catalogue endpoint. */
    refreshModels: (providerId: string) => Promise<Result<ModelInfo[]>>;
    /** All cached ModelInfo records for a provider. */
    listModels: (providerId: string) => Promise<ModelInfo[]>;
    /** Register a new custom OpenAI-compatible provider. */
    addCustom: (input: { name: string; baseUrl: string }) => Promise<Result<ProviderPreset>>;
    /** Remove a previously registered custom provider. */
    removeCustom: (id: string) => Promise<Result<void>>;
    /** Patch fields on a custom provider. */
    updateCustom: (id: string, patch: Partial<ProviderPreset>) => Promise<Result<ProviderPreset>>;
  };

  sessions: {
    /** All sessions for a mode, newest first. */
    list: (mode: Mode) => Promise<Session[]>;
    get: (sessionId: string) => Promise<Session | null>;
    create: (mode: Mode, selection: ModelSelection) => Promise<Result<Session>>;
    archive: (sessionId: string) => Promise<Result<void>>;
    /** Hard-delete a session and all its messages from disk. */
    delete: (sessionId: string) => Promise<Result<void>>;
    /**
     * Fork a session. Creates a new session copying mode, selection, permissionMode,
     * and messages up to (and including) uptoMessageId, or all messages when omitted.
     * Pass null to create an empty-prefix branch for replacing the first turn.
     */
    branch: (sessionId: string, uptoMessageId?: string | null) => Promise<Result<Session>>;
    /** Rename a session. */
    rename: (sessionId: string, title: string) => Promise<Result<void>>;
    /** Change the permission posture for a session. */
    setPermissionMode: (sessionId: string, mode: PermissionMode) => Promise<Result<void>>;
    /** Load the full message history for a session. */
    messages: (sessionId: string) => Promise<Message[]>;
    /** Send a user message and start the agent loop. */
    send: (
      sessionId: string,
      text: string,
      attachments?: string[],
      clientTurnId?: string,
    ) => Promise<Result<void>>;
    /** Request the running loop to stop after its current tool completes. */
    cancel: (sessionId: string) => Promise<Result<void>>;
    /** Respond to a permission_request or question event. */
    reply: (
      sessionId: string,
      requestId: string,
      answer: string | string[],
    ) => Promise<Result<void>>;
    /** Current task list (mirrors the most-recent task_update event). */
    tasks: (sessionId: string) => Promise<AgentTask[]>;
    /** Subscribe to agent events. Returns unsubscribe. */
    onEvent: (cb: (e: AgentEvent) => void) => () => void;
    /** Reattach a refresh-interrupted run; replays the persisted event stream. */
    reattach: (
      sessionId: string,
      sinceRunId?: string,
    ) => Promise<{ runId?: string; events: AgentEvent[]; done: boolean }>;
    /** List persisted runs for a session. */
    listRuns: (sessionId: string) => Promise<RunSummary[]>;
  };

  schedule: {
    list: () => Promise<ScheduledTask[]>;
    create: (
      task: Omit<ScheduledTask, "id" | "createdAt" | "runCount">,
    ) => Promise<Result<ScheduledTask>>;
    update: (
      id: string,
      patch: Partial<ScheduledTask>,
    ) => Promise<Result<ScheduledTask>>;
    remove: (id: string) => Promise<Result<void>>;
    /** Fire a scheduled task immediately without disturbing its cadence. */
    runNow: (id: string) => Promise<Result<void>>;
  };

  mcp: {
    list: () => Promise<McpServerConfig[]>;
    add: (
      config: Omit<McpServerConfig, "id" | "createdAt" | "status" | "toolCount"> & {
        /** Raw token. Encrypted by the main process and never returned. */
        authToken?: string;
      },
    ) => Promise<Result<McpServerConfig>>;
    remove: (id: string) => Promise<Result<void>>;
    setEnabled: (id: string, enabled: boolean) => Promise<Result<void>>;
    tools: (serverId: string) => Promise<McpToolInfo[]>;
  };

  plugins: {
    list: () => Promise<Plugin[]>;
    setEnabled: (id: string, enabled: boolean) => Promise<Result<void>>;
    remove: (id: string) => Promise<Result<void>>;
    installFromUrl: (url: string) => Promise<Result<Plugin>>;
    /** Install a plugin from a local .zip file path (BUG-5 fix). */
    installFromZip: (path: string) => Promise<Result<Plugin>>;
  };

  skills: {
    list: () => Promise<Skill[]>;
    setEnabled: (id: string, enabled: boolean) => Promise<Result<void>>;
  };

  subagents: {
    /** Cancel a running subagent by run id (best-effort). */
    cancel: (runId: string) => Promise<Result<void>>;
  };

  dialog: {
    /** Native folder picker. Resolves to null when cancelled. */
    selectFolder: () => Promise<string | null>;
    selectFiles: () => Promise<string[]>;
  };

  projects: {
    list: () => Promise<Project[]>;
    create: (input: {
      name: string;
      folder: string;
      mode: Mode;
      instructions?: string;
    }) => Promise<Result<Project>>;
    update: (
      id: string,
      patch: { name?: string; folder?: string; mode?: Mode; instructions?: string },
    ) => Promise<Result<Project>>;
    archive: (id: string) => Promise<Result<Project>>;
    remove: (id: string) => Promise<Result<void>>;
  };

  memory: {
    /** Get user-authored standing rules injected into every session prompt. */
    getRules: () => Promise<Result<string>>;
    /** Set user-authored standing rules. Pass empty string to clear. */
    setRules: (text: string) => Promise<Result<void>>;
  };

  preview: {
    /**
     * Read a file for inline preview. Text is capped at ~512 KB; images are
     * returned as base64. Returns {ok:false} when the path is denied or the
     * file cannot be read.
     */
    readFile: (path: string) => Promise<Result<{
      content: string;
      base64?: string;
      mime: string;
      truncated: boolean;
    }>>;
    /** Stat a file: size in bytes and isDir flag. */
    stat: (path: string) => Promise<Result<{ size: number; isDir: boolean }>>;
  };

  browser: {
    /** Live browser state snapshot. */
    state: () => Promise<{
      currentUrl: string;
      title: string;
      isLoading: boolean;
      attached: boolean;
    }>;
    /** Attach the agent's live view to the app window at the given rect. */
    attach: (
      rect: { x: number; y: number; width: number; height: number },
      sessionId?: string,
    ) => Promise<Result<{
      currentUrl: string;
      title: string;
      isLoading: boolean;
      attached: boolean;
    }>>;
    /** Detach the live view from the window. */
    detach: () => Promise<Result<void>>;
    /** Update only the rect of the attached view (on resize). */
    updateBounds: (
      rect: { x: number; y: number; width: number; height: number },
    ) => Promise<{
      currentUrl: string;
      title: string;
      isLoading: boolean;
      attached: boolean;
    }>;
  };

  window: {
    minimize: () => void;
    maximize: () => void;
    close: () => void;
    onState: (cb: (s: WindowState) => void) => () => void;
  };
}

// ── Accessor ───────────────────────────────────────────────────────────────

/**
 * Returns the full typed bridge.
 *
 * Methods that have not yet been wired in the preload will throw when called
 * rather than silently returning undefined, giving clear stack traces.
 */
export function bridge(): KozumBridge {
  const raw = window.kozum as unknown as KozumBridge | undefined;
  if (!raw) {
    throw new Error(
      "window.kozum is not defined. " +
        "The renderer is running outside Electron, or the preload failed to load.",
    );
  }
  return raw;
}
