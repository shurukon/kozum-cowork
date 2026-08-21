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
import type { AgentEvent, McpServerConfig, Mode, ModelSelection, PermissionMode, ProviderPreset, ScheduledTask } from "../../shared/types.ts";
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
import type { TaskStore } from "../tools/tasks.ts";
import type { TaskPatch } from "../schedule/scheduler.ts";
import type { ProjectStore } from "../store/projects.ts";
import type { UpdateProjectPatch, CreateProjectInput } from "../store/projects.ts";
import type { BrowserSurface, SurfaceRect } from "../browser/surface.ts";
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
  memory: MemoryVault;
  dialog: DialogFacade;
  /** sessionId → mode, kept in sync so task_update events carry the right mode. */
  sessionModes?: Map<string, Mode>;
  /** Visible browser surface for live browser preview (BP-A). */
  browserSurface?: BrowserSurface;
  /** Subagent manager — used for the subagents:cancel IPC (§10.3). */
  subagents?: SubagentManager;
  /** Returns the ElectronBrowserBackend's WebContentsView for attachment, or null. */
  getBrowserView?: () =>
    | {
        webContents: {
          getURL(): string;
          on(event: string, listener: (...args: unknown[]) => void): void;
          removeListener?(event: string, listener: (...args: unknown[]) => void): void;
          isDestroyed?(): boolean;
        };
        setBounds(b: { x: number; y: number; width: number; height: number }): void;
        setAutoResize?(opts: { width: boolean; height: boolean }): void;
      }
    | null;
  /** Captures the actual agent-controlled Chromium view for live verification/export. */
  getBrowserScreenshot?: (opts?: { fullPage?: boolean; quality?: number }) => Promise<{
    data: string;
    mimeType: "image/jpeg";
    width: number;
    height: number;
  }>;
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
    return [...PROVIDER_PRESETS, ...custom];
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
    const payload = input as { name?: unknown; baseUrl?: unknown };
    const name = String(payload.name ?? "").trim();
    const baseUrl = String(payload.baseUrl ?? "").trim();
    if (!name) return err("name is required");
    if (!baseUrl) return err("baseUrl is required");

    const id = `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const preset: ProviderPreset = {
      id,
      name,
      protocol: "openai-chat",
      baseUrl,
      authScheme: "bearer",
      modelsPath: "/models",
      builtIn: false,
    };

    const settings = await deps.settings.get();
    const existing = Array.isArray(settings.customProviders) ? settings.customProviders : [];
    await deps.settings.patch({ customProviders: [...existing, preset] });
    return ok(preset);
  });

  handle(ipcMain, "providers:removeCustom", async (_e, id) => {
    const settings = await deps.settings.get();
    const existing = Array.isArray(settings.customProviders) ? settings.customProviders : [];
    const next = existing.filter((p) => p.id !== String(id));
    if (next.length === existing.length) return err(`Custom provider "${String(id)}" not found`);
    await deps.settings.patch({ customProviders: next });
    return ok(undefined);
  });

  handle(ipcMain, "providers:updateCustom", async (_e, id, patch) => {
    const settings = await deps.settings.get();
    const existing = Array.isArray(settings.customProviders) ? settings.customProviders : [];
    const idx = existing.findIndex((p) => p.id === String(id));
    if (idx === -1) return err(`Custom provider "${String(id)}" not found`);
    const updated = { ...existing[idx]!, ...(patch as Partial<ProviderPreset>) };
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
    const done = await deps.sessions.archive(String(sessionId));
    if (!done) return err(`Session "${String(sessionId)}" not found`);
    return ok(undefined);
  });

  handle(ipcMain, "sessions:delete", async (_e, sessionId) => {
    const done = await deps.sessions.delete(String(sessionId));
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

    const view = deps.getBrowserView?.();
    if (!view) return err("No active browser session. Navigating to a page first will create one.");

    const rect = rectRaw as SurfaceRect | undefined;
    if (!rect) return err("rect is required.");
    if (typeof rect.x !== "number" || typeof rect.y !== "number" || typeof rect.width !== "number" || typeof rect.height !== "number") {
      return err("rect must have numeric x, y, width, height.");
    }

    try {
      deps.browserSurface.attachTo(win, view, rect);
      return ok(deps.browserSurface.getState());
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
