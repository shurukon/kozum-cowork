/**
 * IPC handler registration.
 *
 * Every channel maps 1:1 to a KozumBridge method. Handlers wrap their work in
 * a try/catch and return Result<T> envelopes; they never throw across the
 * IPC boundary.
 */

import { randomUUID } from "node:crypto";
import type { IpcMain, BrowserWindow, App } from "electron";
import type { AgentEvent, McpServerConfig, Mode, ModelSelection, ScheduledTask } from "../../shared/types.ts";
import { ok, err } from "../../shared/types.ts";
import { PROVIDER_PRESETS } from "../providers/presets.ts";
import type { SettingsStore } from "../store/settings.ts";
import type { SecretStore } from "../store/secrets.ts";
import type { ProviderRegistry } from "../providers/registry.ts";
import type { SessionStore } from "../session/store.ts";
import type { SessionManager } from "../session/manager.ts";
import type { Scheduler } from "../schedule/scheduler.ts";
import type { McpManager } from "../mcp/manager.ts";
import type { PluginManager } from "../plugins/manager.ts";
import type { SkillStore } from "../skills/index.ts";
import type { TaskStore } from "../tools/tasks.ts";
import type { TaskPatch } from "../schedule/scheduler.ts";
import type { ProjectStore } from "../store/projects.ts";
import type { UpdateProjectPatch, CreateProjectInput } from "../store/projects.ts";

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
  tasks: TaskStore;
  projects: ProjectStore;
  dialog: DialogFacade;
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

  ipcMain.handle("providers:presets", () => PROVIDER_PRESETS);

  handle(ipcMain, "providers:addKey", async (_e, providerId, label, rawKey, meta) => {
    const entry = await deps.secrets.add(
      String(providerId),
      String(label),
      String(rawKey),
      meta as Record<string, string> | undefined,
    );
    return ok(entry);
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
    const models = await deps.registry.refreshModels(String(providerId), keys[0]!.id);
    return ok(models);
  });

  handle(ipcMain, "providers:listModels", async (_e, providerId) => {
    return deps.registry.listModels(String(providerId));
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
    return ok(session);
  });

  handle(ipcMain, "sessions:archive", async (_e, sessionId) => {
    const done = await deps.sessions.archive(String(sessionId));
    if (!done) return err(`Session "${String(sessionId)}" not found`);
    return ok(undefined);
  });

  handle(ipcMain, "sessions:messages", async (_e, sessionId) => {
    return deps.sessions.messages(String(sessionId));
  });

  handle(ipcMain, "sessions:send", async (_e, sessionId, text, attachments) => {
    return deps.sessionManager.send(
      String(sessionId),
      String(text),
      Array.isArray(attachments) ? (attachments as string[]) : [],
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
    return ok(created);
  });

  handle(ipcMain, "schedule:update", async (_e, id, patch) => {
    const updated = deps.scheduler.update(String(id), patch as TaskPatch);
    if (!updated) return err(`Scheduled task "${String(id)}" not found`);
    return ok(updated);
  });

  handle(ipcMain, "schedule:remove", async (_e, id) => {
    const removed = deps.scheduler.remove(String(id));
    if (!removed) return err(`Scheduled task "${String(id)}" not found`);
    return ok(undefined);
  });

  /* -------------------------------------------------------------- mcp --- */

  handle(ipcMain, "mcp:list", async () => {
    return deps.mcp.status();
  });

  handle(ipcMain, "mcp:add", async (_e, config) => {
    // The renderer may pass an optional `authToken` field that must never be
    // persisted in plain text and must never be returned to the renderer.
    type AddPayload = Omit<McpServerConfig, "id" | "createdAt" | "status" | "toolCount"> & {
      authToken?: string;
    };
    const payload = config as AddPayload;
    // Extract and strip the raw token before building the persisted config.
    const { authToken, ...rest } = payload;
    const hasAuthToken = Boolean(authToken) || rest.hasAuthToken;

    const full: McpServerConfig = {
      ...rest,
      hasAuthToken,
      id: randomUUID(),
      createdAt: Date.now(),
      status: "disconnected" as const,
      toolCount: 0,
    };

    deps.mcp.add(full);

    // Connect, passing the raw token in memory only (never persisted).
    await deps.mcp.connect(full.id, { authToken }).catch(() => undefined);

    const updated = deps.mcp.status().find((s) => s.id === full.id);
    // The returned value must not carry authToken (it was never on McpServerConfig).
    return ok(updated ?? full);
  });

  handle(ipcMain, "mcp:remove", async (_e, id) => {
    await deps.mcp.remove(String(id));
    return ok(undefined);
  });

  handle(ipcMain, "mcp:setEnabled", async (_e, id, enabled) => {
    if (Boolean(enabled)) {
      deps.mcp.enable(String(id));
      await deps.mcp.connect(String(id)).catch(() => undefined);
    } else {
      await deps.mcp.disable(String(id));
    }
    return ok(undefined);
  });

  handle(ipcMain, "mcp:tools", async (_e, serverId) => {
    return deps.mcp.allTools().filter((t) => t.serverId === String(serverId));
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

  handle(ipcMain, "skills:list", async () => {
    return deps.skills.list().map((s) => ({
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
    }));
  });

  handle(ipcMain, "skills:setEnabled", async (_e, _id, _enabled) => {
    // SkillStore doesn't persist enabled state via a toggle; accept the call.
    return ok(undefined);
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
