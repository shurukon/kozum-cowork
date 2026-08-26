/**
 * IPC handler registration.
 *
 * Every channel maps 1:1 to a KozumBridge method. Handlers wrap their work in
 * a try/catch and return Result<T> envelopes; they never throw across the
 * IPC boundary.
 */

import { randomUUID } from "node:crypto";
import { readFile, stat as fsStat } from "node:fs/promises";
import { extname } from "node:path";
import { spawn } from "node:child_process";
import electron from "electron";
import type { IpcMain, BrowserWindow, App } from "electron";

const { shell } = electron;
import type { AgentEvent, CustomProviderInput, McpServerConfig, Mode, ModelSelection, PermissionMode, ProviderPreset, ScheduledTask } from "../../shared/types.ts";
import { ok, err } from "../../shared/types.ts";
import { resolvePath, PathError } from "../tools/paths.ts";
import { PROVIDER_PRESETS } from "../providers/presets.ts";
import type { MemoryVault } from "../memory/vault.ts";
import type { SettingsStore } from "../store/settings.ts";
import type { SecretStore } from "../store/secrets.ts";
import type { ProviderRegistry } from "../providers/registry.ts";
import type { SessionStore } from "../session/store.ts";
import type { SessionManager } from "../session/manager.ts";
import type { Scheduler } from "../schedule/scheduler.ts";
import type { McpManager } from "../mcp/manager.ts";
import type { PluginManager } from "../plugins/manager.ts";
import type { SkillStore } from "../skills/index.ts";
import { installSkillSource } from "../skills/index.ts";
import type { TaskStore } from "../tools/tasks.ts";
import type { TaskPatch } from "../schedule/scheduler.ts";
import type { ProjectStore } from "../store/projects.ts";
import type { UpdateProjectPatch, CreateProjectInput } from "../store/projects.ts";
import type { BrowserSurface, SurfaceRect } from "../browser/surface.ts";
import type { LocalPreviewServer } from "../preview/server.ts";
import type { SubagentManager } from "../agent/subagents.ts";

/* ---------------------------------------------------------------- dialog facade --- */

/**
 * Inject interface for Electron's dialog module so the handler is testable
 * without Electron.
 */
export interface DialogFacade {
  showOpenDialog(options: {
    properties: string[];
  }): Promise<{ canceled: boolean; filePaths: string[] }>;
}

/** Minimal WebContentsView facade shared by browser IPC dependencies. */
export interface BrowserViewFacade {
  webContents: {
    getURL(): string;
    on(event: string, listener: (...args: unknown[]) => void): void;
    removeListener?(event: string, listener: (...args: unknown[]) => void): void;
    isDestroyed?(): boolean;
  };
  setBounds(b: { x: number; y: number; width: number; height: number }): void;
  setAutoResize?(opts: { width: boolean; height: boolean }): void;
}

export interface IpcDeps {
  ipcMain: IpcMain;
  app: App;
  getWindow: () => BrowserWindow | null;
  isDev: boolean;
  userDataPath: string;
  settings: SettingsStore;
  secrets: SecretStore;
  registry: ProviderRegistry;
  sessions: SessionStore;
  sessionManager: SessionManager;
  scheduler: Scheduler;
  mcp: McpManager;
  plugins: PluginManager;
  skills: SkillStore;
  /** userData/skills root — where user-added skills are installed. */
  userSkillsRoot?: string;
  tasks: TaskStore;
  projects: ProjectStore;
  memory: MemoryVault;
  dialog: DialogFacade;
  /** sessionId → mode, kept in sync so task_update events carry the right mode. */
  sessionModes?: Map<string, Mode>;
  /** Visible browser surface for live browser preview (BP-A). */
  browserSurface?: BrowserSurface;
  /** Subagent manager — used for the subagents:cancel IPC (§10.3). */
  subagents?: SubagentManager;
  /** Returns the ElectronBrowserBackend's WebContentsView for attachment, or null. */
  getBrowserView?: () => BrowserViewFacade | null;
  /**
   * Creates/returns the same shared view when attach wins the race with the
   * first browser tool. Kept separate from getBrowserView because the latter is
   * intentionally a synchronous snapshot.
   */
  ensureBrowserView?: () => Promise<BrowserViewFacade>;
  /** Captures the actual agent-controlled Chromium view for live verification/export. */
  getBrowserScreenshot?: (opts?: { fullPage?: boolean; quality?: number }) => Promise<{
    data: string;
    mimeType: "image/jpeg";
    width: number;
    height: number;
  }>;
  /** Serves a user-owned HTML tree through a hardened loopback origin. */
  previewServer?: LocalPreviewServer;
}

/** Wrap an async handler so a thrown error becomes {ok:false, error}. */
function handle(
  ipcMain: IpcMain,
  channel: string,
  fn: (_event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>,
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await fn(event, ...args);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(msg);
    }
  });
}

export function registerIpc(deps: IpcDeps): void {
  const { ipcMain } = deps;

  /* -------------------------------------------------------------- dialog --- */

  handle(ipcMain, "dialog:selectFolder", async () => {
    const result = await deps.dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  });

  handle(ipcMain, "dialog:selectFiles", async () => {
    const result = await deps.dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"],
    });
    if (result.canceled) return [];
    return result.filePaths;
  });

  /* ---------------------------------------------------------------- app --- */

  handle(ipcMain, "app:info", async () => ({
    version: deps.app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron ?? "",
    node: process.versions.node,
    chrome: process.versions.chrome ?? "",
    userDataPath: deps.userDataPath,
    isDev: deps.isDev,
  }));

  /* ---------------------------------------------------------- settings --- */

  handle(ipcMain, "settings:get", async () => {
    return deps.settings.get();
  });

  handle(ipcMain, "settings:set", async (_e, patch) => {
    return deps.settings.patch(patch as Parameters<typeof deps.settings.patch>[0]);
  });

  /* --------------------------------------------------------- providers --- */

  handle(ipcMain, "providers:presets", async () => {
    const settings = await deps.settings.get();
    const custom = Array.isArray(settings.customProviders) ? settings.customProviders : [];
    const overrides = (settings as unknown as { providerOverrides?: Record<string, { agentRouterMode?: string }> }).providerOverrides ?? {};
    // The legacy built-in "custom" escape hatch was removed; filter defensively
    // in case an old persisted blob ever resurrects it.
    const builtIns = PROVIDER_PRESETS
      .filter((p) => p.id !== "custom")
      .map((p) => {
        const ov = overrides[p.id];
        if (ov && typeof ov.agentRouterMode === "string") {
          return { ...p, agentRouterMode: ov.agentRouterMode as ProviderPreset["agentRouterMode"] };
        }
        return p;
      });
    return [...builtIns, ...custom.filter((c) => c.id !== "custom")];
  });

  handle(ipcMain, "providers:addKey", async (_e, providerId, label, rawKey, meta) => {
    // Label is optional: default to "Key N" based on how many keys the provider has.
    const existing = await deps.secrets.list(String(providerId));
    const resolvedLabel =
      label !== undefined && label !== null && String(label).trim()
        ? String(label)
        : `Key ${existing.length + 1}`;
    const entry = await deps.secrets.add(
      String(providerId),
      resolvedLabel,
      String(rawKey),
      meta as Record<string, string> | undefined,
    );
    return ok(entry);
  });

  handle(ipcMain, "providers:addCustom", async (_e, input) => {
    const payload = input as Partial<CustomProviderInput> & { protocol?: CustomProviderInput["protocol"] };
    const name = String(payload.name ?? "").trim();
    const baseUrl = String(payload.baseUrl ?? "").trim();
    const apiKey = String(payload.apiKey ?? "").trim();
    const modelId = String(payload.modelId ?? "").trim();
    if (!name) return err("Provider name is required.");
    if (!baseUrl) return err("Base URL is required.");
    if (!/^https?:\/\//i.test(baseUrl)) return err("Base URL must start with http:// or https://.");
    if (!apiKey) return err("API key is required when creating a provider.");
    if (!modelId) return err("Model ID is required when creating a provider.");

    // Enforce unique name across built-ins and customs (case-insensitive) to keep selection unambiguous.
    const settingsForNameCheck = await deps.settings.get();
    const existingForCheck = Array.isArray(settingsForNameCheck.customProviders) ? settingsForNameCheck.customProviders : [];
    const allNames = new Set([
      ...PROVIDER_PRESETS.map((p) => p.name.toLowerCase()),
      ...existingForCheck.map((p) => p.name.toLowerCase()),
    ]);
    if (allNames.has(name.toLowerCase())) {
      return err(`Provider name "${name}" already exists. Choose a different name.`);
    }

    const protocols = ["openai-chat", "openai-responses", "anthropic-messages"] as const;
    const requested = String(payload.protocol ?? "openai-chat") as typeof protocols[number];
    const protocol = protocols.includes(requested) ? requested : "openai-chat";
    const id = `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const preset: ProviderPreset = {
      id,
      name,
      protocol,
      baseUrl: baseUrl.replace(/\/+$/, ""),
      authScheme: protocol === "anthropic-messages" ? "x-api-key" : "bearer",
      modelsPath: "/models",
      staticModels: [modelId],
      builtIn: false,
    };

    const existing = existingForCheck;
    await deps.settings.patch({ customProviders: [...existing, preset] });
    try {
      await deps.secrets.add(id, "Key 1", apiKey);
    } catch (cause) {
      // Roll back the provider definition so a failed secret write cannot leave
      // an unusable provider in the picker.
      await deps.settings.patch({ customProviders: existing }).catch(() => undefined);
      return err(`Provider was not created because its API key could not be stored: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    return ok(preset);
  });

  handle(ipcMain, "providers:removeCustom", async (_e, id) => {
    const providerId = String(id);
    const settings = await deps.settings.get();
    const existing = Array.isArray(settings.customProviders) ? settings.customProviders : [];
    const next = existing.filter((p) => p.id !== providerId);
    if (next.length === existing.length) return err(`Custom provider "${providerId}" not found`);

    const resetSelection = (mode: "cowork" | "code") =>
      settings[mode].selection.providerId === providerId
        ? { ...settings[mode], selection: { providerId: "", keyId: null, modelId: "" } }
        : settings[mode];
    await deps.settings.patch({
      customProviders: next,
      cowork: resetSelection("cowork"),
      code: resetSelection("code"),
    });
    for (const key of await deps.secrets.list(providerId)) {
      await deps.secrets.remove(key.id).catch(() => undefined);
    }
    return ok(undefined);
  });

  handle(ipcMain, "providers:updateCustom", async (_e, id, patch) => {
    const providerId = String(id);
    const settings = await deps.settings.get();
    const existing = Array.isArray(settings.customProviders) ? settings.customProviders : [];
    const idx = existing.findIndex((p) => p.id === providerId);
    if (idx === -1) return err(`Custom provider "${providerId}" not found`);
    const requested = patch as Partial<ProviderPreset>;
    if (requested.name !== undefined || requested.baseUrl !== undefined) {
      return err("A custom provider's name and Base URL are fixed after creation.");
    }
    const updated = { ...existing[idx]!, ...requested, id: providerId, builtIn: false };
    const next = [...existing];
    next[idx] = updated;
    await deps.settings.patch({ customProviders: next });
    return ok(updated);
  });

  handle(ipcMain, "providers:addModel", async (_e, providerId, modelId) => {
    const id = String(providerId);
    const model = String(modelId ?? "").trim();
    if (!model) return err("Model ID is required.");
    const settings = await deps.settings.get();
    const existing = Array.isArray(settings.customProviders) ? settings.customProviders : [];
    const idx = existing.findIndex((p) => p.id === id);
    if (idx === -1) return err(`Custom provider "${id}" not found`);
    const provider = existing[idx]!;
    const models = provider.staticModels ?? [];
    if (models.includes(model)) return err(`Model "${model}" is already registered for this provider.`);
    const updated = { ...provider, staticModels: [...models, model] };
    const next = [...existing];
    next[idx] = updated;
    await deps.settings.patch({ customProviders: next });
    return ok(updated);
  });

  handle(ipcMain, "providers:removeModel", async (_e, providerId, modelId) => {
    const id = String(providerId);
    const model = String(modelId ?? "").trim();
    const settings = await deps.settings.get();
    const existing = Array.isArray(settings.customProviders) ? settings.customProviders : [];
    const idx = existing.findIndex((p) => p.id === id);
    if (idx === -1) return err(`Custom provider "${id}" not found`);
    const provider = existing[idx]!;
    const models = provider.staticModels ?? [];
    if (!models.includes(model)) return err(`Model "${model}" is not registered for this provider.`);
    if (models.length <= 1) return err("A custom provider must keep at least one model ID.");
    const updated = { ...provider, staticModels: models.filter((entry) => entry !== model) };
    const next = [...existing];
    next[idx] = updated;
    await deps.settings.patch({ customProviders: next });
    return ok(updated);
  });

  handle(ipcMain, "providers:removeKey", async (_e, keyId) => {
    const removed = await deps.secrets.remove(String(keyId));
    if (!removed) return err(`Key "${String(keyId)}" not found`);
    return ok(undefined);
  });

  handle(ipcMain, "providers:listKeys", async (_e, providerId) => {
    return deps.secrets.list(String(providerId));
  });

  handle(ipcMain, "providers:testKey", async (_e, keyId) => {
    await deps.registry.testKey(String(keyId));
    return ok(undefined);
  });

  handle(ipcMain, "providers:refreshModels", async (_e, providerId) => {
    const keys = await deps.secrets.list(String(providerId));
    if (keys.length === 0) {
      return err(`No API key configured for provider "${String(providerId)}"`);
    }
    const { models, warning } = await deps.registry.refreshModelsDetailed(
      String(providerId),
      keys[0]!.id,
    );
    // Typed fallback signal — the renderer toasts this instead of failing.
    return ok({ models, warning });
  });

  handle(ipcMain, "providers:listModels", async (_e, providerId) => {
    return deps.registry.listModels(String(providerId));
  });

  handle(ipcMain, "providers:setAgentRouterMode", async (_e, mode) => {
    const m = String(mode);
    if (m !== "auto" && m !== "openai" && m !== "anthropic") {
      return err(`Invalid AgentRouter mode "${m}". Expected auto, openai, or anthropic.`);
    }
    const settings = await deps.settings.get();
    const overrides = (settings as unknown as { providerOverrides?: Record<string, { agentRouterMode?: string }> }).providerOverrides ?? {};
    const next = { ...overrides, agentrouter: { agentRouterMode: m } };
    const updated = await deps.settings.patch({ providerOverrides: next } as unknown as Parameters<typeof deps.settings.patch>[0]);
    return ok(updated);
  });

  /* ---------------------------------------------------------- sessions --- */

  handle(ipcMain, "sessions:list", async (_e, mode) => {
    return deps.sessions.list(mode as Mode);
  });

  handle(ipcMain, "sessions:get", async (_e, sessionId) => {
    return deps.sessions.get(String(sessionId));
  });

  handle(ipcMain, "sessions:create", async (_e, mode, selection) => {
    const session = await deps.sessions.create(mode as Mode, selection as ModelSelection);
    const modeSettings = await deps.settings.get();
    const requestedMode = mode as Mode;
    const permissionMode = modeSettings[requestedMode]?.permissionMode;
    if (permissionMode && permissionMode !== session.permissionMode) {
      await deps.sessions.setPermissionMode(session.id, permissionMode);
    }
    const created = await deps.sessions.get(session.id);
    deps.sessionModes?.set(session.id, session.mode);
    return ok(created ?? session);
  });

  handle(ipcMain, "sessions:archive", async (_e, sessionId) => {
    const id = String(sessionId);
    await deps.sessionManager.teardown(id);
    const done = await deps.sessions.archive(id);
    if (!done) return err(`Session "${String(sessionId)}" not found`);
    return ok(undefined);
  });

  handle(ipcMain, "sessions:delete", async (_e, sessionId) => {
    const id = String(sessionId);
    await deps.sessionManager.teardown(id);
    const done = await deps.sessions.delete(id);
    if (!done) return err(`Session "${String(sessionId)}" not found`);
    return ok(undefined);
  });

  handle(ipcMain, "sessions:branch", async (_e, sessionId, uptoMessageId) => {
    const newSession = await deps.sessions.branch(
      String(sessionId),
      uptoMessageId === null ? null : uptoMessageId !== undefined ? String(uptoMessageId) : undefined,
    );
    if (!newSession) return err(`Session "${String(sessionId)}" not found`);
    return ok(newSession);
  });

  handle(ipcMain, "sessions:rename", async (_e, sessionId, title) => {
    const done = await deps.sessions.rename(String(sessionId), String(title));
    if (!done) return err(`Session "${String(sessionId)}" not found`);
    return ok(undefined);
  });

  // T7/T8: in-place history truncation for Regenerate/Edit.
  handle(ipcMain, "sessions:truncateFrom", async (_e, sessionId, messageId, opts) => {
    const inclusive = opts === undefined ? true : Boolean((opts as { inclusive?: boolean }).inclusive);
    return deps.sessions.truncateFrom(String(sessionId), String(messageId), { inclusive });
  });

  handle(ipcMain, "sessions:setPermissionMode", async (_e, sessionId, mode) => {
    const done = await deps.sessions.setPermissionMode(
      String(sessionId),
      String(mode) as PermissionMode,
    );
    if (!done) return err(`Session "${String(sessionId)}" not found`);
    return ok(undefined);
  });

  handle(ipcMain, "sessions:messages", async (_e, sessionId) => {
    return deps.sessions.messages(String(sessionId));
  });

  /**
   * Reattach after a refresh (P1-7 / §9.4). Returns the most-recent unfinished
   * run's events so the renderer can replay them and catch up a half-consumed
   * turn. Pass `sinceRunId` to fetch only that run's events.
   */
  handle(ipcMain, "sessions:reattach", async (_e, sessionId, sinceRunId) => {
    const runs = await deps.sessions.listRuns(String(sessionId));
    if (runs.length === 0) return { done: true, events: [] };

    const target = sinceRunId
      ? runs.find((r) => r.runId === String(sinceRunId))
      : runs[runs.length - 1];

    if (!target) return { done: true, events: [] };

    const all = await deps.sessions.readRunEvents(String(sessionId), target.runId);
    const events = sinceRunId ? all.filter((e) => e.runId === String(sinceRunId)) : all;

    // If the run already finished, there is nothing live to catch up on.
    if (target.finished && !sinceRunId) return { done: true, events: [] };

    return { runId: target.runId, events, done: false };
  });

  handle(ipcMain, "sessions:listRuns", async (_e, sessionId) => {
    return deps.sessions.listRuns(String(sessionId));
  });

  handle(ipcMain, "sessions:send", async (_e, sessionId, text, attachments, clientTurnId) => {
    const session = await deps.sessions.get(String(sessionId));
    if (session) deps.sessionModes?.set(String(sessionId), session.mode);
    return deps.sessionManager.send(
      String(sessionId),
      String(text),
      Array.isArray(attachments) ? (attachments as string[]) : [],
      typeof clientTurnId === "string" && clientTurnId.length > 0 ? clientTurnId : undefined,
    );
  });

  handle(ipcMain, "sessions:cancel", async (_e, sessionId) => {
    return deps.sessionManager.cancel(String(sessionId));
  });

  handle(ipcMain, "sessions:reply", async (_e, sessionId, requestId, answer) => {
    return deps.sessionManager.reply(
      String(sessionId),
      String(requestId),
      answer as string | string[],
    );
  });

  handle(ipcMain, "sessions:tasks", async (_e, sessionId) => {
    return deps.tasks.list(String(sessionId));
  });

  handle(ipcMain, "subagents:cancel", async (_e, runId) => {
    if (!deps.subagents) return err("subagent manager not configured");
    const cancelled = deps.subagents.cancel(String(runId));
    if (!cancelled) return err(`Subagent "${String(runId)}" not running`);
    return ok(undefined);
  });

  /* ---------------------------------------------------------- schedule --- */

  handle(ipcMain, "schedule:list", async () => {
    return deps.scheduler.list();
  });

  handle(ipcMain, "schedule:create", async (_e, task) => {
    const t = task as Omit<ScheduledTask, "id" | "createdAt" | "runCount">;
    const created = deps.scheduler.add({
      name: t.name,
      prompt: t.prompt,
      cron: t.cron,
      timezone: t.timezone,
      mode: t.mode,
      workingFolder: t.workingFolder ?? null,
      selection: t.selection ?? null,
    });
    await deps.scheduler.flush();
    return ok(created);
  });

  handle(ipcMain, "schedule:update", async (_e, id, patch) => {
    const updated = deps.scheduler.update(String(id), patch as TaskPatch);
    if (!updated) return err(`Scheduled task "${String(id)}" not found`);
    await deps.scheduler.flush();
    return ok(updated);
  });

  handle(ipcMain, "schedule:remove", async (_e, id) => {
    const removed = deps.scheduler.remove(String(id));
    if (!removed) return err(`Scheduled task "${String(id)}" not found`);
    await deps.scheduler.flush();
    return ok(undefined);
  });

  handle(ipcMain, "schedule:runNow", async (_e, id) => {
    try {
      await deps.scheduler.runNow(String(id));
      return ok(undefined);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(msg);
    }
  });

  /* -------------------------------------------------------------- mcp --- */

  handle(ipcMain, "mcp:list", async () => {
    return deps.mcp.status();
  });

  type McpInput = Omit<McpServerConfig, "id" | "createdAt" | "status" | "toolCount"> & {
    authToken?: string;
  };

  handle(ipcMain, "mcp:testConnection", async (_e, config) => {
    const payload = config as McpInput;
    const { authToken, ...serverConfig } = payload;
    try {
      return ok(await deps.mcp.testConnection(serverConfig, { authToken }));
    } catch (cause) {
      let msg = cause instanceof Error ? cause.message : String(cause);
      // Turn the raw SSRF message into actionable guidance for the common
      // loopback case (the form auto-ticks the box, but a stale client may not).
      if (msg.startsWith("SSRF guard") && serverConfig.allowLocal !== true) {
        try {
          const host = new URL(String(serverConfig.url ?? "")).hostname.toLowerCase();
          if (host === "localhost" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
            msg = "This is a local MCP server: enable \"Allow localhost / local network\" in the add-server form, then test again.";
          }
        } catch { /* keep original */ }
      }
      return err(msg);
    }
  });

  handle(ipcMain, "mcp:add", async (_e, config) => {
    // The renderer may pass an optional `authToken` field that must never be
    // persisted in plain text and must never be returned to the renderer.
    const payload = config as McpInput;
    // Extract and strip the raw token before building the persisted config.
    const { authToken, ...rest } = payload;
    const hasAuthToken = Boolean(authToken) || rest.hasAuthToken;

    // A syntactically valid URL is not a connected MCP server. Require the
    // actual initialize + tools/list handshake before persisting it — unless
    // the server indicates OAuth is required (401 + authorization_uri), in
    // which case we persist the entry so the user can trigger the login flow.
    let oauthRequired = false;
    try {
      await deps.mcp.testConnection(rest, { authToken });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      const low = msg.toLowerCase();
      const isOAuthHint = low.includes("401") || low.includes("authorization") || low.includes("bearer") || low.includes("oauth") || low.includes("www-authenticate");
      if (isOAuthHint) {
        oauthRequired = true;
      } else {
        return err(msg);
      }
    }

    const full: McpServerConfig = {
      ...rest,
      hasAuthToken,
      id: randomUUID(),
      createdAt: Date.now(),
      status: "disconnected" as const,
      toolCount: 0,
    };

    await deps.mcp.add(full);

    // Connect enabled servers, passing the raw token in memory only (never
    // persisted). A deliberately disabled server is valid after handshake and
    // can be enabled later from Customize.
    if (full.enabled) {
      await deps.mcp.connect(full.id, { authToken }).catch(() => undefined);
    }

    const updated = deps.mcp.status().find((s) => s.id === full.id);
    if (oauthRequired) {
      // Persisted for OAuth login — UI will call mcp:oauthLogin to open browser and complete.
      return ok(updated!);
    }
    if (!updated || (full.enabled && updated.status !== "connected")) {
      await deps.mcp.remove(full.id);
      return err(updated?.statusMessage ?? "MCP server failed to connect after validation.");
    }
    // The returned value must not carry authToken (it was never on McpServerConfig).
    return ok(updated);
  });

  handle(ipcMain, "mcp:remove", async (_e, id) => {
    await deps.mcp.remove(String(id));
    return ok(undefined);
  });

  handle(ipcMain, "mcp:setEnabled", async (_e, id, enabled) => {
    if (Boolean(enabled)) {
      await deps.mcp.enable(String(id));
      await deps.mcp.connect(String(id)).catch(() => undefined);
    } else {
      await deps.mcp.disable(String(id));
    }
    return ok(undefined);
  });

  handle(ipcMain, "mcp:tools", async (_e, serverId) => {
    return deps.mcp.allTools().filter((t) => t.serverId === String(serverId));
  });

  handle(ipcMain, "mcp:oauthLogin", async (_e, id) => {
    const serverId = String(id);
    const entry = deps.mcp.status().find((s) => s.id === serverId);
    if (!entry) return err(`MCP server "${serverId}" not found`);
    const mcpUrl = entry.url;
    if (!mcpUrl) return err(`MCP server "${serverId}" has no URL`);
    try {
      const { startMcpOAuthFlow } = await import("../mcp/oauth.ts");
      const result = await startMcpOAuthFlow({
        mcpUrl,
        openExternal: (url: string) => shell.openExternal(url),
        existingClientId: entry.oauthClientId,
      });
      // Persist the DCR-issued client_id (and secret, when issued) before
      // connecting so subsequent logins reuse the same client identity.
      await deps.mcp.setOAuthClientId(serverId, result.clientId);
      if (result.refreshToken) {
        await deps.secrets.add(`mcp-oauth:${serverId}`, "OAuth refresh token", result.refreshToken).catch(() => undefined);
      }
      await deps.mcp.setAuthToken(serverId, result.accessToken);
      await deps.mcp.connect(serverId, { authToken: result.accessToken }).catch(() => undefined);
      const updated = deps.mcp.status().find((s) => s.id === serverId);
      if (!updated || updated.status !== "connected") {
        return err(updated?.statusMessage ?? "OAuth succeeded but MCP server still failed to connect.");
      }
      return ok(updated);
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      return err(`OAuth login failed: ${msg}`);
    }
  });

  handle(ipcMain, "mcp:discoverOAuth", async (_e, url) => {
    const mcpUrl = String(url);
    if (!mcpUrl) return err("URL is required");
    try {
      const { discoverOAuthForMcp } = await import("../mcp/oauth.ts");
      const meta = await discoverOAuthForMcp(mcpUrl);
      return ok(meta);
    } catch (cause) {
      return err(cause instanceof Error ? cause.message : String(cause));
    }
  });

  handle(ipcMain, "mcp:setToolPolicy", async (_e, serverId, policy) => {
    const raw = policy as { default?: unknown; tools?: unknown } | null;
    if (!raw || (raw.default !== "allow" && raw.default !== "deny" && raw.default !== "ask")) {
      return err("policy.default must be one of allow|deny|ask");
    }
    let tools: Record<string, "allow" | "deny" | "ask"> | undefined;
    if (raw.tools !== undefined && raw.tools !== null) {
      if (typeof raw.tools !== "object" || Array.isArray(raw.tools)) {
        return err("policy.tools must be an object keyed by tool name");
      }
      tools = {};
      for (const [tool, action] of Object.entries(raw.tools as Record<string, unknown>)) {
        if (action === "allow" || action === "deny" || action === "ask") {
          tools[tool] = action;
        }
      }
    }
    const updated = await deps.mcp.setToolPolicy(String(serverId), {
      default: raw.default as "allow" | "deny" | "ask",
      ...(tools !== undefined ? { tools } : {}),
    });
    if (!updated) return err(`MCP server "${String(serverId)}" not found`);
    return ok(updated);
  });

  /* ---------------------------------------------------------- plugins --- */

  handle(ipcMain, "plugins:list", async () => {
    return deps.plugins.list();
  });

  handle(ipcMain, "plugins:setEnabled", async (_e, id, enabled) => {
    if (Boolean(enabled)) {
      await deps.plugins.enable(String(id));
    } else {
      await deps.plugins.disable(String(id));
    }
    return ok(undefined);
  });

  handle(ipcMain, "plugins:remove", async (_e, id) => {
    await deps.plugins.uninstall(String(id));
    return ok(undefined);
  });

  handle(ipcMain, "plugins:installFromUrl", async (_e, url) => {
    const plugin = await deps.plugins.installFromGitHub(String(url));
    return ok(plugin);
  });

  handle(ipcMain, "plugins:installFromZip", async (_e, rawPath) => {
    // BUG-5 fix: the renderer's "Install from .zip" tab used to call the URL
    // handler with a local file path, which then tried to fetch it as a
    // GitHub URL and broke. This dedicated handler resolves the local path
    // (same rules as preview:readFile) and hands the buffer to the plugin
    // manager's installFromZip.
    const path = String(rawPath ?? "");
    if (!path) return err("path is required");
    if (!path.toLowerCase().endsWith(".zip")) {
      return err("path must point to a .zip file");
    }

    const resolved = await resolvePath(path, { workingFolder: null }).catch((e: unknown) => {
      if (e instanceof PathError) return e;
      throw e;
    });
    if (resolved instanceof PathError) return err(resolved.message);

    try {
      const buf = await readFile(resolved);
      const plugin = await deps.plugins.installFromZip(buf, resolved);
      return ok(plugin);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(msg);
    }
  });

  /* ---------------------------------------------------------- projects --- */

  handle(ipcMain, "projects:list", async () => {
    return deps.projects.list();
  });

  handle(ipcMain, "projects:get", async (_e, id) => {
    return deps.projects.get(String(id));
  });

  handle(ipcMain, "projects:create", async (_e, input) => {
    const i = input as CreateProjectInput;
    const result = await deps.projects.create(i);
    if (!result.ok) return err(result.error);
    return ok(result.value);
  });

  handle(ipcMain, "projects:update", async (_e, id, patch) => {
    const result = await deps.projects.update(String(id), patch as UpdateProjectPatch);
    if (!result.ok) return err(result.error);
    return ok(result.value);
  });

  handle(ipcMain, "projects:archive", async (_e, id) => {
    const result = await deps.projects.archive(String(id));
    if (!result.ok) return err(result.error);
    return ok(result.value);
  });

  handle(ipcMain, "projects:remove", async (_e, id) => {
    const result = await deps.projects.remove(String(id));
    if (!result.ok) return err(result.error);
    return ok(undefined);
  });

  /* ----------------------------------------------------------- skills --- */

  const toSkillView = (s: ReturnType<SkillStore["list"]>[number]) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    ...(s.whenToUse ? { whenToUse: s.whenToUse } : {}),
    path: s.path,
    source: s.source,
    ...(s.pluginId ? { pluginId: s.pluginId } : {}),
    enabled: s.enabled,
    modes: s.modes,
    ...(s.allowedTools ? { allowedTools: s.allowedTools } : {}),
  });

  handle(ipcMain, "skills:list", async () => {
    return deps.skills.list().map(toSkillView);
  });

  handle(ipcMain, "skills:setEnabled", async (_e, id, enabled) => {
    const changed = deps.skills.setEnabled(String(id), Boolean(enabled));
    return changed ? ok(undefined) : err(`Skill not found: ${String(id)}`);
  });

  /**
   * Install a skill from a user-selected folder (containing SKILL.md) or a
   * single .md file into the userData skills root, then rescan. Returns the
   * refreshed catalogue.
   */
  handle(ipcMain, "skills:add", async (_e, rawPath) => {
    const sourcePath = String(rawPath ?? "").trim();
    if (!sourcePath) return err("source path is required");
    if (!deps.userSkillsRoot) return err("user skills root is not available in this build");
    const result = await installSkillSource(deps.skills, deps.userSkillsRoot, sourcePath);
    if (!result.ok) return err(result.error);
    return ok(deps.skills.list().map(toSkillView));
  });

  /** Remove a skill previously installed into the userData root; bundled and legacy entries are refused. */
  handle(ipcMain, "skills:remove", async (_e, id) => {
    try {
      const removed = await deps.skills.removeUserSkill(String(id));
      if (!removed) {
        return err(`Skill "${String(id)}" not found or not removable (only skills you added can be removed).`);
      }
      return ok(undefined);
    } catch (cause) {
      return err(cause instanceof Error ? cause.message : String(cause));
    }
  });

  /* ----------------------------------------------------------- memory --- */

  handle(ipcMain, "memory:getRules", async () => {
    const rules = await deps.memory.getRules();
    return ok(rules);
  });

  handle(ipcMain, "memory:setRules", async (_e, text) => {
    await deps.memory.setRules(String(text ?? ""));
    return ok(undefined);
  });

  /* ---------------------------------------------------------- preview (read-only) --- */

  /** Maximum bytes of text we return for a preview. */
  const PREVIEW_TEXT_CAP = 512 * 1024; // 512 KB

  /** MIME type map by extension — mirrors the fs.ts image map. */
  const MIME_MAP: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    svg: "image/svg+xml",
    ico: "image/x-icon",
    tiff: "image/tiff",
    tif: "image/tiff",
    avif: "image/avif",
    pdf: "application/pdf",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    avi: "video/x-msvideo",
    mkv: "video/x-matroska",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    flac: "audio/flac",
    m4a: "audio/mp4",
  };

  const BINARY_PREVIEW_EXTS = new Set([
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "tiff", "tif", "avif",
    "pdf", "mp4", "webm", "mov", "avi", "mkv", "mp3", "wav", "ogg", "flac", "m4a",
  ]);

  handle(ipcMain, "preview:readFile", async (_e, rawPath) => {
    const path = String(rawPath ?? "");
    if (!path) return err("path is required");

    const resolved = await resolvePath(path, { workingFolder: null }).catch((e: unknown) => {
      if (e instanceof PathError) return e;
      throw e;
    });
    if (resolved instanceof PathError) return err(resolved.message);

    const ext = extname(resolved).toLowerCase().slice(1);
    const mime = MIME_MAP[ext] ?? "text/plain";

    try {
      const buf = await readFile(resolved);

      if (BINARY_PREVIEW_EXTS.has(ext)) {
        const binaryCap = 32 * 1024 * 1024;
        if (buf.length > binaryCap) {
          return err(`Preview is limited to ${binaryCap / (1024 * 1024)} MB for binary media.`);
        }
        return ok({
          content: "",
          base64: buf.toString("base64"),
          mime,
          truncated: false,
        });
      }

      const truncated = buf.length > PREVIEW_TEXT_CAP;
      const slice = truncated ? buf.slice(0, PREVIEW_TEXT_CAP) : buf;
      const content = slice.toString("utf-8");
      return ok({ content, mime, truncated });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(msg);
    }
  });

  handle(ipcMain, "preview:stat", async (_e, rawPath) => {
    const path = String(rawPath ?? "");
    if (!path) return err("path is required");

    const resolved = await resolvePath(path, { workingFolder: null }).catch((e: unknown) => {
      if (e instanceof PathError) return e;
      throw e;
    });
    if (resolved instanceof PathError) return err(resolved.message);

    try {
      const s = await fsStat(resolved);
      return ok({ size: s.size, isDir: s.isDirectory() });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(msg);
    }
  });

  handle(ipcMain, "preview:openLiveHtml", async (_e, rawPath) => {
    if (!deps.previewServer) {
      return err("live HTML preview is not available in this build.");
    }
    const path = String(rawPath ?? "");
    if (!path) return err("path is required");
    const resolved = await resolvePath(path, { workingFolder: null }).catch((e: unknown) => {
      if (e instanceof PathError) return e;
      throw e;
    });
    if (resolved instanceof PathError) return err(resolved.message);

    try {
      const handle = await deps.previewServer.open(resolved);
      return ok(handle);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(msg);
    }
  });

  handle(ipcMain, "preview:open", async (_e, rawPath, rawAction) => {
    const path = String(rawPath ?? "");
    const action = String(rawAction ?? "external");
    if (!path) return err("path is required");
    if (!["external", "reveal", "ide"].includes(action)) return err("unsupported preview open action");

    const resolved = await resolvePath(path, { workingFolder: null }).catch((e: unknown) => {
      if (e instanceof PathError) return e;
      throw e;
    });
    if (resolved instanceof PathError) return err(resolved.message);

    try {
      if (action === "reveal") {
        shell.showItemInFolder(resolved);
        return ok(undefined);
      }
      if (action === "external") {
        const error = await shell.openPath(resolved);
        return error ? err(error) : ok(undefined);
      }

      const command = process.env.KOZUM_IDE_COMMAND?.trim() || (process.platform === "win32" ? "code.cmd" : "code");
      const child = spawn(command, [resolved], { detached: true, stdio: "ignore" });
      return await new Promise((resolve) => {
        let settled = false;
        const finish = (result: ReturnType<typeof ok> | ReturnType<typeof err>) => {
          if (settled) return;
          settled = true;
          resolve(result);
        };
        child.once("spawn", () => {
          child.unref();
          finish(ok(undefined));
        });
        child.once("error", (error) => finish(err(`Could not launch IDE '${command}': ${error.message}`)));
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(msg);
    }
  });

  /* ---------------------------------------------------------- browser (live preview — BP-A) --- */

  /**
   * browser:attach — the renderer requests hosting the agent's live browser
   * view over the PreviewPanel area. The backend re-parents the engine's
   * WebContentsView into the app BrowserWindow at the given screen rect.
   *
   * The rect is in renderer CSS pixels relative to the window content area.
   * Because the BrowserWindow and renderer share devicePixelRatio, setBounds
   * in CSS pixels works correctly on Windows (the default).
   */
  handle(ipcMain, "browser:attach", async (_e, rectRaw, _sessionId) => {
    if (!deps.browserSurface) return err("browser surface not available in this build.");
    const win = deps.getWindow();
    if (!win) return err("app window is not available.");

    const rect = rectRaw as SurfaceRect | undefined;
    if (!rect) return err("rect is required.");
    if (typeof rect.x !== "number" || typeof rect.y !== "number" || typeof rect.width !== "number" || typeof rect.height !== "number") {
      return err("rect must have numeric x, y, width, height.");
    }

    // R6: route through the surface's sequence-guarded attach. If the preview
    // unmounts while the lazy WebContentsView is still being created, the
    // late resolve is discarded instead of re-parenting an orphaned native
    // view over the whole app (the old "browser covers everything until
    // restart" bug).
    try {
      const state = await deps.browserSurface.attachWhenReady(
        win,
        async () => {
          let view = deps.getBrowserView?.() ?? null;
          if (!view && deps.ensureBrowserView) {
            try {
              view = await deps.ensureBrowserView();
            } catch {
              view = null;
            }
          }
          return view;
        },
        rect,
      );
      if (!state.attached) {
        return err("No active browser session. Navigating to a page first will create one.");
      }
      return ok(state);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(msg);
    }
  });

  /** browser:detach — remove the live view from the window (preview closed). */
  handle(ipcMain, "browser:detach", async () => {
    if (!deps.browserSurface) return ok(undefined);
    const win = deps.getWindow();
    deps.browserSurface.detachFrom(win);
    return ok(undefined);
  });

  /** browser:state — poll the current URL, title, loading state, and attach flag. */
  handle(ipcMain, "browser:state", async () => {
    if (!deps.browserSurface) return ok({ currentUrl: "", title: "", isLoading: false, attached: false });
    return ok(deps.browserSurface.getState());
  });

  /** browser:screenshot — capture the actual agent-controlled Chromium view. */
  handle(ipcMain, "browser:screenshot", async (_e, optsRaw) => {
    if (!deps.getBrowserScreenshot) return err("browser screenshot is not available in this build.");
    try {
      return ok(await deps.getBrowserScreenshot(optsRaw as { fullPage?: boolean; quality?: number } | undefined));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(msg);
    }
  });

  /** browser:updateBounds — update only the rect of the attached view (resize). */
  handle(ipcMain, "browser:updateBounds", async (_e, rectRaw) => {
    if (!deps.browserSurface) return ok(undefined);
    const rect = rectRaw as SurfaceRect | undefined;
    if (!rect) return ok(undefined);
    deps.browserSurface.updateBounds(rect);
    return ok(deps.browserSurface.getState());
  });

  /* Window commands are fire-and-forget (ipcMain.on), handled in main index. */
}

/**
 * Create the emitEvent callback that the SessionManager uses to push events
 * to the renderer.
 */
export function makeEmitEvent(
  getWindow: () => { webContents: { send: (channel: string, ...args: unknown[]) => void } } | null,
): (sessionId: string, e: AgentEvent) => void {
  return (_sessionId: string, e: AgentEvent) => {
    const win = getWindow();
    if (!win) return;
    win.webContents.send("sessions:event", e);
  };
}
