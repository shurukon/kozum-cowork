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
  Skill,
  Result,
  Mode,
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
    /** Add a new API key. Returns the created entry (key stored encrypted). */
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
  };

  sessions: {
    /** All sessions for a mode, newest first. */
    list: (mode: Mode) => Promise<Session[]>;
    get: (sessionId: string) => Promise<Session | null>;
    create: (mode: Mode, selection: ModelSelection) => Promise<Result<Session>>;
    archive: (sessionId: string) => Promise<Result<void>>;
    /** Load the full message history for a session. */
    messages: (sessionId: string) => Promise<Message[]>;
    /** Send a user message and start the agent loop. */
    send: (sessionId: string, text: string, attachments?: string[]) => Promise<Result<void>>;
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
  };

  mcp: {
    list: () => Promise<McpServerConfig[]>;
    add: (
      config: Omit<McpServerConfig, "id" | "createdAt" | "status" | "toolCount">,
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
  };

  skills: {
    list: () => Promise<Skill[]>;
    setEnabled: (id: string, enabled: boolean) => Promise<Result<void>>;
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
