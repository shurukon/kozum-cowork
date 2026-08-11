// @ts-nocheck — This is a browser-preview-only mock. It injects stub
// implementations so the UI can render without Electron. Strict typing is
// intentionally relaxed here; the real bridge (src/preload/index.ts) is fully
// typed and is what production uses.
/**
 * Mock bridge — injects a stub `window.kozum` object so the renderer can
 * load and display its UI in a plain browser (without Electron).
 *
 * All IPC calls return safe default values (empty arrays, ok:true, etc.)
 * so the UI renders without crashing. No backend operations actually work —
 * this is for visual preview only.
 *
 * Loaded via an import in main.tsx before the React app boots.
 * In Electron the preload script already set window.kozum, so this is a
 * no-op (the guard at the top skips injection if window.kozum exists).
 */
(function () {
  // Skip if the real Electron preload bridge is already present.
  if (typeof window.kozum !== "undefined") return;
  const ok = (v) => ({ ok: true, value: v });
  const err = (msg) => ({ ok: false, error: msg });
  const noop = () => {};

  const mockSettings = {
    general: {
      userName: "Preview User",
      workDescription: "",
      customInstructions: "",
      appearance: "dark",
      chatFont: "sans",
      motion: "system",
      language: "en",
      defaultFolders: { cowork: null, code: null },
      rules: "",
      autoOpenPreviews: true,
      autoOpenBrowserPreview: true,
    },
    cowork: {
      selection: null,
      maxTokens: 8192,
      temperature: 0.7,
      maxIterations: 25,
      permissionMode: "accept_edits",
      enabledToolNames: [],
      subagentsEnabled: true,
    },
    code: {
      selection: null,
      maxTokens: 16384,
      temperature: 0,
      maxIterations: 50,
      permissionMode: "manual",
      enabledToolNames: [],
      subagentsEnabled: false,
    },
    computerUse: { enabled: false },
    scheduler: { keepAwake: false },
    privacy: { telemetry: false as const },
    customProviders: [],
  };

  const mockState = {
    currentUrl: "",
    title: "",
    isLoading: false,
    attached: false,
  };

  window.kozum = {
    app: { info: async () => ({ version: "0.5.0-preview", platform: "web", arch: "x64", electron: "33.0", node: "22.0", chrome: "130.0", userDataPath: "/tmp/preview", isDev: true }) },
    settings: { get: async () => mockSettings, set: async (patch) => ({ ...mockSettings, ...patch }) },
    providers: {
      presets: async () => [
        { id: "anthropic", name: "Anthropic", protocol: "anthropic-messages", baseUrl: "", authScheme: "bearer", builtIn: true, staticModels: [{ id: "claude-sonnet-4-20250514", displayName: "Claude Sonnet 4", contextWindow: 200000, vision: "yes" }] },
        { id: "openai", name: "OpenAI", protocol: "openai-chat", baseUrl: "https://api.openai.com/v1", authScheme: "bearer", modelsPath: "/models", builtIn: true, staticModels: [{ id: "gpt-4o", displayName: "GPT-4o", contextWindow: 128000, vision: "yes" }] },
      ],
      addKey: async (pid, label, key, meta) => ok({ id: "key-1", providerId: pid, label: label || "Key 1", maskedKey: "sk-••••••••", status: "untested", createdAt: Date.now(), meta }),
      removeKey: async () => ok(undefined),
      listKeys: async () => [],
      testKey: async () => ok(undefined),
      refreshModels: async () => ok([{ id: "claude-sonnet-4-20250514", displayName: "Claude Sonnet 4", contextWindow: 200000, vision: "yes" as const }]),
      listModels: async () => [{ id: "claude-sonnet-4-20250514", displayName: "Claude Sonnet 4", contextWindow: 200000, vision: "yes" as const }],
      addCustom: async (input) => ok({ id: "custom_1", name: input.name, protocol: "openai-chat", baseUrl: input.baseUrl, authScheme: "bearer", modelsPath: "/models", builtIn: false }),
      removeCustom: async () => ok(undefined),
      updateCustom: async (_id, patch) => ok({ id: "custom_1", name: "Custom", protocol: "openai-chat", baseUrl: "https://example.com", authScheme: "bearer", modelsPath: "/models", builtIn: false, ...patch }),
    },
    sessions: {
      list: async () => [],
      get: async () => null,
      create: async (mode, selection) => ok({ id: "session-preview", mode, title: "Preview Session", selection, permissionMode: "accept_edits", workingFolder: null, projectId: null, createdAt: Date.now(), updatedAt: Date.now(), archived: false }),
      archive: async () => ok(undefined),
      delete: async () => ok(undefined),
      branch: async () => ok({ id: "session-branched", mode: "cowork", title: "Branched", selection: null, permissionMode: "accept_edits", workingFolder: null, projectId: null, createdAt: Date.now(), updatedAt: Date.now(), archived: false }),
      rename: async () => ok(undefined),
      setPermissionMode: async () => ok(undefined),
      messages: async () => [],
      send: async () => ok(undefined),
      cancel: async () => ok(undefined),
      reply: async () => ok(undefined),
      tasks: async () => [],
      reattach: async () => ({ done: true, events: [] }),
      listRuns: async () => [],
      onEvent: (cb) => { return () => {}; },
    },
    schedule: {
      list: async () => [],
      create: async (task) => ok({ ...task, id: "sched-1", createdAt: Date.now(), runCount: 0, enabled: true }),
      update: async (_id, patch) => ok({ id: "sched-1", name: "Task", prompt: "", cron: "0 9 * * *", timezone: "UTC", enabled: true, mode: "cowork", projectId: null, workingFolder: null, selection: null, createdAt: Date.now(), runCount: 0, ...patch }),
      remove: async () => ok(undefined),
      runNow: async () => ok(undefined),
    },
    subagents: { cancel: async () => ok(undefined) },
    mcp: {
      list: async () => [],
      add: async (config) => ok({ ...config, id: "mcp-1", createdAt: Date.now(), status: "disconnected", toolCount: 0 }),
      remove: async () => ok(undefined),
      setEnabled: async () => ok(undefined),
      tools: async () => [],
    },
    plugins: {
      list: async () => [],
      setEnabled: async () => ok(undefined),
      remove: async () => ok(undefined),
      installFromUrl: async () => ok({ id: "plugin-1", name: "Plugin", description: "", version: "1.0", author: "", path: "", enabled: true, skills: [], agents: [], commands: [], mcpServers: [], hasHooks: false }),
      installFromZip: async () => ok({ id: "plugin-1", name: "Plugin", description: "", version: "1.0", author: "", path: "", enabled: true, skills: [], agents: [], commands: [], mcpServers: [], hasHooks: false }),
    },
    skills: { list: async () => [], setEnabled: async () => ok(undefined) },
    dialog: { selectFolder: async () => null, selectFiles: async () => [] },
    projects: {
      list: async () => [],
      create: async (input) => ok({ id: "proj-1", name: input.name, folder: input.folder, instructions: "", createdAt: Date.now(), updatedAt: Date.now(), archived: false, mode: input.mode }),
      update: async (_id, patch) => ok({ id: "proj-1", name: "Project", folder: "/tmp", instructions: "", createdAt: Date.now(), updatedAt: Date.now(), archived: false, mode: "cowork", ...patch }),
      archive: async () => ok({ id: "proj-1", name: "Project", folder: "/tmp", instructions: "", createdAt: Date.now(), updatedAt: Date.now(), archived: true, mode: "cowork" }),
      remove: async () => ok(undefined),
    },
    memory: { getRules: async () => ok(""), setRules: async () => ok(undefined) },
    preview: {
      readFile: async () => err("Preview not available in browser mode"),
      stat: async () => err("Preview not available in browser mode"),
    },
    browser: {
      attach: async () => err("Browser preview not available in browser mode"),
      detach: async () => ok(undefined),
      state: async () => mockState,
      updateBounds: async () => mockState,
    },
    window: {
      minimize: noop,
      maximize: noop,
      close: noop,
      onState: (cb) => { cb({ maximized: false, focused: true }); return () => {}; },
    },
  };
})();
