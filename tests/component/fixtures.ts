/**
 * Shared test fixtures for component tests.
 *
 * All bridge methods are real async functions that return sensible defaults.
 * NO mocking library is used — this is a plain-object fake.
 */

import type { KozumBridge } from "../../src/renderer/bridge.ts";
import type {
  AppSettings,
  ProviderPreset,
  ApiKeyEntry,
  Session,
  ScheduledTask,
  McpServerConfig,
  Plugin,
  Skill,
  AgentEvent,
} from "@shared/types.ts";

// ── Default AppSettings ───────────────────────────────────────────────────

export function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  const baseModeSettings = {
    selection: { providerId: "", keyId: null, modelId: "" },
    systemPromptOverride: null,
    maxTokens: 8192,
    temperature: 0.5,
    maxIterations: 50,
    permissionMode: "accept_edits" as const,
    enabledToolNames: null,
  };

  return {
    general: {
      userName: "Test User",
      workDescription: "Tester",
      customInstructions: "",
      rules: "",
      defaultFolders: { cowork: null, code: null },
      appearance: "system",
      chatFont: "sans",
      motion: "system",
      language: "en",
    },
    cowork: { ...baseModeSettings },
    code: { ...baseModeSettings },
    computerUse: { enabled: false, blocklist: [], requireConfirmation: true },
    browser: { enabled: false, userAgent: null, headless: true },
    network: { alwaysAllowHosts: [], proxyUrl: null, githubFirewallRule: false },
    scheduler: { enabled: true, keepAwake: true },
    privacy: { telemetry: false },
    customize: { accentColor: "#68c8ed", surfaceColor: "#101923", fontFamily: "sans" },
    customProviders: [],
    ...overrides,
  };
}

export function makeConfiguredSettings(): AppSettings {
  return makeSettings({
    cowork: {
      selection: { providerId: "anthropic", keyId: "key-1", modelId: "claude-opus-4-5" },
      systemPromptOverride: null,
      maxTokens: 8192,
      temperature: 0.5,
      maxIterations: 50,
      permissionMode: "accept_edits",
      enabledToolNames: null,
    },
  });
}

// ── Provider presets ──────────────────────────────────────────────────────

export const FAKE_PRESETS: ProviderPreset[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    protocol: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    authScheme: "x-api-key",
    modelsPath: "/v1/models",
    docsUrl: "https://docs.anthropic.com",
    builtIn: true,
  },
  {
    id: "openai",
    name: "OpenAI",
    protocol: "openai-chat",
    baseUrl: "https://api.openai.com",
    authScheme: "bearer",
    modelsPath: "/v1/models",
    docsUrl: "https://platform.openai.com",
    builtIn: true,
  },
];

export const FAKE_KEYS: Record<string, ApiKeyEntry[]> = {
  anthropic: [
    {
      id: "key-1",
      providerId: "anthropic",
      label: "Personal",
      maskedKey: "sk-ant-…abc1",
      createdAt: Date.now(),
      status: "valid",
    },
  ],
  openai: [],
};

export const FAKE_SKILLS: Skill[] = [
  {
    id: "skill-1",
    name: "Code Review",
    description: "Reviews code for bugs and improvements.",
    path: "/skills/code-review.md",
    source: "builtin",
    enabled: true,
    modes: ["code"],
  },
];

export const FAKE_CONNECTORS: McpServerConfig[] = [
  {
    id: "mcp-1",
    name: "Local MCP",
    enabled: true,
    transport: "http",
    url: "http://localhost:3000/mcp",
    hasAuthToken: false,
    createdAt: Date.now(),
    installedByAgent: false,
    status: "connected",
    toolCount: 5,
  },
];

export const FAKE_PLUGINS: Plugin[] = [
  {
    id: "plugin-1",
    name: "Engineering Pack",
    description: "A set of engineering tools.",
    version: "1.0.0",
    enabled: true,
    source: { kind: "builtin" },
    installedAt: Date.now(),
    updatedAt: Date.now(),
    path: "/plugins/engineering",
    skills: ["code-review"],
    agents: ["reviewer"],
    commands: [],
    mcpServers: [],
    hasHooks: false,
    installedByAgent: false,
  },
];

// ── Session fixture ───────────────────────────────────────────────────────

export function makeSession(id = "sess-1"): Session {
  return {
    id,
    mode: "cowork",
    title: "Test session",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: "idle",
    workingFolder: null,
    projectId: null,
    selection: { providerId: "anthropic", keyId: "key-1", modelId: "claude-opus-4-5" },
    messageCount: 0,
    totalUsage: { inputTokens: 0, outputTokens: 0 },
    archived: false,
    permissionMode: "accept_edits",
  };
}

export function makeScheduledTask(id = "task-1"): ScheduledTask {
  return {
    id,
    name: "Daily brief",
    prompt: "Summarise what changed since yesterday.",
    cron: "0 9 * * *",
    timezone: "UTC",
    enabled: true,
    mode: "cowork",
    projectId: null,
    workingFolder: null,
    selection: null,
    createdAt: Date.now(),
    runCount: 0,
  };
}

export function makeMcpServer(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: "mcp-new",
    name: "test-server.example.com",
    enabled: true,
    transport: "http",
    url: "https://test-server.example.com/mcp",
    hasAuthToken: false,
    createdAt: Date.now(),
    installedByAgent: false,
    status: "connected",
    toolCount: 3,
    ...overrides,
  };
}

export function makePlugin(overrides: Partial<Plugin> = {}): Plugin {
  return {
    id: "plugin-new",
    name: "New Plugin",
    description: "A newly installed plugin.",
    version: "0.1.0",
    enabled: true,
    source: { kind: "zip", originalName: "plugin.zip" },
    installedAt: Date.now(),
    updatedAt: Date.now(),
    path: "/plugins/new-plugin",
    skills: [],
    agents: [],
    commands: [],
    mcpServers: [],
    hasHooks: false,
    installedByAgent: false,
    ...overrides,
  };
}

// ── Fake bridge ───────────────────────────────────────────────────────────

/**
 * Build a fake window.kozum bridge.
 *
 * All methods are plain async functions — no mocking library.
 * Pass overrides to replace specific methods for individual test scenarios.
 */
export function makeFakeBridge(
  overrides: Partial<{
    settings: Partial<KozumBridge["settings"]>;
    providers: Partial<KozumBridge["providers"]>;
    sessions: Partial<KozumBridge["sessions"]>;
    schedule: Partial<KozumBridge["schedule"]>;
    mcp: Partial<KozumBridge["mcp"]>;
    plugins: Partial<KozumBridge["plugins"]>;
    skills: Partial<KozumBridge["skills"]>;
    dialog: Partial<KozumBridge["dialog"]>;
    projects: Partial<KozumBridge["projects"]>;
    memory: Partial<KozumBridge["memory"]>;
    preview: Partial<KozumBridge["preview"]>;
    window: Partial<KozumBridge["window"]>;
    app: Partial<KozumBridge["app"]>;
  }> = {},
): KozumBridge {
  const settings: KozumBridge["settings"] = {
    get: async () => makeSettings(),
    set: async (patch) => ({ ...makeSettings(), ...patch }),
    ...overrides.settings,
  };

  const providers: KozumBridge["providers"] = {
    presets: async () => FAKE_PRESETS,
    addKey: async (_pid, _label, _raw) => ({ ok: true, value: FAKE_KEYS.anthropic[0]! }),
    removeKey: async (_id) => ({ ok: true, value: undefined }),
    listKeys: async (pid) => FAKE_KEYS[pid] ?? [],
    testKey: async (_id) => ({ ok: true, value: undefined }),
    refreshModels: async (_pid) => ({ ok: true, value: [] }),
    listModels: async (_pid) => [],
    addCustom: async (input) => ({ ok: true, value: { id: "custom-1", name: input.name, protocol: "openai-chat", baseUrl: input.baseUrl, authScheme: "bearer", modelsPath: "/models", builtIn: false } }),
    removeCustom: async (_id) => ({ ok: true, value: undefined }),
    updateCustom: async (_id, _patch) => ({ ok: true, value: { id: "custom-1", name: "c", protocol: "openai-chat", baseUrl: "https://x", authScheme: "bearer", modelsPath: "/models", builtIn: false } }),
    ...overrides.providers,
  };

  const sessions: KozumBridge["sessions"] = {
    list: async (_mode) => [],
    get: async (_id) => null,
    create: async (_mode, _selection) => ({
      ok: true,
      value: makeSession(),
    }),
    archive: async (_id) => ({ ok: true, value: undefined }),
    messages: async (_id) => [],
    send: async (_id, _text) => ({ ok: true, value: undefined }),
    cancel: async (_id) => ({ ok: true, value: undefined }),
    reply: async (_id, _reqId, _answer) => ({ ok: true, value: undefined }),
    tasks: async (_id) => [],
    onEvent: (_cb: (e: AgentEvent) => void) => () => {},
    ...overrides.sessions,
  };

  const schedule: KozumBridge["schedule"] = {
    list: async () => [],
    create: async (task) => ({ ok: true, value: { ...makeScheduledTask(), ...task, id: "task-new", createdAt: Date.now(), runCount: 0 } }),
    update: async (_id, patch) => ({ ok: true, value: { ...makeScheduledTask(), ...patch } }),
    remove: async (_id) => ({ ok: true, value: undefined }),
    ...overrides.schedule,
  };

  const mcp: KozumBridge["mcp"] = {
    list: async () => [],
    add: async (_config) => ({ ok: true, value: makeMcpServer() }),
    remove: async (_id) => ({ ok: true, value: undefined }),
    setEnabled: async (_id, _en) => ({ ok: true, value: undefined }),
    tools: async (_id) => [],
    ...overrides.mcp,
  };

  const plugins: KozumBridge["plugins"] = {
    list: async () => [],
    setEnabled: async (_id, _en) => ({ ok: true, value: undefined }),
    remove: async (_id) => ({ ok: true, value: undefined }),
    installFromUrl: async (_url) => ({ ok: true, value: makePlugin() }),
    ...overrides.plugins,
  };

  const skills: KozumBridge["skills"] = {
    list: async () => [],
    setEnabled: async (_id, _en) => ({ ok: true, value: undefined }),
    ...overrides.skills,
  };

  const dialog: KozumBridge["dialog"] = {
    selectFolder: async () => "/home/user/projects",
    selectFiles: async () => [],
    ...overrides.dialog,
  };

  const projects: KozumBridge["projects"] = {
    list: async () => [],
    create: async (input) => ({
      ok: true,
      value: {
        id: "proj-1",
        name: input.name,
        folder: input.folder,
        instructions: input.instructions ?? "",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        archived: false,
        mode: input.mode,
      },
    }),
    update: async (_id, _patch) => ({
      ok: true,
      value: {
        id: "proj-1",
        name: "Project",
        folder: null,
        instructions: "",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        archived: false,
        mode: "cowork",
      },
    }),
    archive: async (_id) => ({
      ok: true,
      value: {
        id: "proj-1",
        name: "Project",
        folder: null,
        instructions: "",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        archived: true,
        mode: "cowork",
      },
    }),
    remove: async (_id) => ({ ok: true, value: undefined }),
    ...overrides.projects,
  };

  const window_: KozumBridge["window"] = {
    minimize: () => {},
    maximize: () => {},
    close: () => {},
    onState: (_cb) => () => {},
    ...overrides.window,
  };

  const app: KozumBridge["app"] = {
    info: async () => ({
      version: "0.3.0",
      platform: "win32",
      arch: "x64",
      electron: "33.0.0",
      node: "22.0.0",
      chrome: "130.0.0",
      userDataPath: "C:\\Users\\test\\AppData\\Roaming\\kozum-cowork",
      isDev: false,
    }),
    ...overrides.app,
  };

  const memory: KozumBridge["memory"] = {
    getRules: async () => ({ ok: true, value: "" }),
    setRules: async (_t) => ({ ok: true, value: undefined }),
    ...overrides.memory,
  };

  const preview: KozumBridge["preview"] = {
    readFile: async (_p) => ({ ok: true, value: { content: "", mime: "text/plain", truncated: false } }),
    stat: async (_p) => ({ ok: true, value: { size: 0, isDir: false } }),
    ...overrides.preview,
  };

  return { settings, providers, sessions, schedule, mcp, plugins, skills, dialog, projects, memory, preview, window: window_, app };
}

/**
 * Install a fake bridge onto window.kozum and return a cleanup function.
 * Use in beforeEach/afterEach.
 */
export function installFakeBridge(bridge: KozumBridge): () => void {
  (window as unknown as Record<string, unknown>)["kozum"] = bridge;
  return () => {
    delete (window as unknown as Record<string, unknown>)["kozum"];
  };
}
