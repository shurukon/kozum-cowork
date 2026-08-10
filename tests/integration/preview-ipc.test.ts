/**
 * Integration tests for preview IPC handlers: preview:readFile and preview:stat.
 *
 * The handlers use resolvePath() from paths.ts and Node fs — no Electron
 * dependency. We call the handler functions directly via a minimal fake
 * ipcMain that records the registered handlers.
 *
 * Run with:
 *   node --experimental-strip-types --test tests/integration/preview-ipc.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IpcMainInvokeEvent } from "electron";

/* ── Minimal fake ipcMain ────────────────────────────────────────────────── */

type Handler = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => Promise<unknown>;

class FakeIpcMain {
  private readonly handlers = new Map<string, Handler>();

  handle(channel: string, fn: Handler): void {
    this.handlers.set(channel, fn);
  }

  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const fn = this.handlers.get(channel);
    if (!fn) throw new Error(`No handler for channel: ${channel}`);
    return fn({} as IpcMainInvokeEvent, ...args);
  }
}

/* ── Minimal fake deps for registerIpc ─────────────────────────────────── */

import { registerIpc } from "../../src/main/ipc/index.ts";

function makeDeps(ipcMain: FakeIpcMain) {
  // We only need the two preview handlers, but registerIpc registers all
  // handlers so we need minimal stubs for the rest.
  return {
    ipcMain: ipcMain as unknown as import("electron").IpcMain,
    app: {
      getVersion: () => "0.0.0-test",
    } as unknown as import("electron").App,
    getWindow: () => null,
    isDev: false,
    userDataPath: tmpDir,
    settings: {
      get: async () => ({ customProviders: [] }),
      patch: async () => ({}),
    } as unknown as import("../../src/main/store/settings.ts").SettingsStore,
    secrets: {
      list: async () => [],
      add: async () => ({}),
      remove: async () => false,
    } as unknown as import("../../src/main/store/secrets.ts").SecretStore,
    registry: {
      testKey: async () => undefined,
      refreshModels: async () => [],
      listModels: async () => [],
    } as unknown as import("../../src/main/providers/registry.ts").ProviderRegistry,
    sessions: {
      list: async () => [],
      get: async () => null,
      create: async () => ({}),
      archive: async () => false,
      delete: async () => false,
      branch: async () => null,
      rename: async () => false,
      setPermissionMode: async () => false,
      messages: async () => [],
    } as unknown as import("../../src/main/session/store.ts").SessionStore,
    sessionManager: {
      send: async () => ({ ok: false, error: "stub" }),
      cancel: async () => ({ ok: false, error: "stub" }),
      reply: async () => ({ ok: false, error: "stub" }),
    } as unknown as import("../../src/main/session/manager.ts").SessionManager,
    scheduler: {
      list: () => [],
      add: () => ({}),
      update: () => null,
      remove: () => false,
    } as unknown as import("../../src/main/schedule/scheduler.ts").Scheduler,
    mcp: {
      status: () => [],
      add: () => undefined,
      connect: async () => undefined,
      remove: async () => undefined,
      enable: () => undefined,
      disable: async () => undefined,
      allTools: () => [],
    } as unknown as import("../../src/main/mcp/manager.ts").McpManager,
    plugins: {
      list: () => [],
      enable: async () => undefined,
      disable: async () => undefined,
      uninstall: async () => undefined,
      installFromGitHub: async () => ({}),
    } as unknown as import("../../src/main/plugins/manager.ts").PluginManager,
    skills: {
      list: () => [],
    } as unknown as import("../../src/main/skills/index.ts").SkillStore,
    tasks: {
      list: async () => [],
    } as unknown as import("../../src/main/tools/tasks.ts").TaskStore,
    projects: {
      list: async () => [],
      get: async () => null,
      create: async () => ({ ok: false, error: "stub" }),
      update: async () => ({ ok: false, error: "stub" }),
      archive: async () => ({ ok: false, error: "stub" }),
      remove: async () => ({ ok: false, error: "stub" }),
    } as unknown as import("../../src/main/store/projects.ts").ProjectStore,
    memory: {
      getRules: async () => "",
      setRules: async () => undefined,
    } as unknown as import("../../src/main/memory/vault.ts").MemoryVault,
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    },
  };
}

/* ── Setup ────────────────────────────────────────────────────────────────── */

let tmpDir: string;
let ipc: FakeIpcMain;

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "kozum-preview-ipc-"));
  ipc = new FakeIpcMain();
  registerIpc(makeDeps(ipc) as Parameters<typeof registerIpc>[0]);
});

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/* ── preview:stat ──────────────────────────────────────────────────────────── */

describe("preview:stat", () => {
  it("returns size and isDir:false for a regular file", async () => {
    const filePath = join(tmpDir, "stat-test.txt");
    await writeFile(filePath, "hello world");
    const result = await ipc.invoke("preview:stat", filePath) as {
      ok: boolean;
      value?: { size: number; isDir: boolean };
    };
    assert.ok(result.ok, "expected ok:true");
    assert.ok(typeof result.value?.size === "number");
    assert.ok(result.value!.size > 0);
    assert.equal(result.value!.isDir, false);
  });

  it("returns isDir:true for a directory", async () => {
    const dirPath = join(tmpDir, "stat-dir");
    await mkdir(dirPath, { recursive: true });
    const result = await ipc.invoke("preview:stat", dirPath) as {
      ok: boolean;
      value?: { size: number; isDir: boolean };
    };
    assert.ok(result.ok);
    assert.equal(result.value!.isDir, true);
  });

  it("returns ok:false for a missing path", async () => {
    const result = await ipc.invoke("preview:stat", join(tmpDir, "no-such-file.txt")) as {
      ok: boolean;
      error?: string;
    };
    assert.equal(result.ok, false);
    assert.ok(typeof result.error === "string" && result.error.length > 0);
  });

  it("returns ok:false for empty path", async () => {
    const result = await ipc.invoke("preview:stat", "") as { ok: boolean };
    assert.equal(result.ok, false);
  });
});

/* ── preview:readFile ────────────────────────────────────────────────────── */

describe("preview:readFile", () => {
  it("reads a small text file", async () => {
    const filePath = join(tmpDir, "hello.ts");
    await writeFile(filePath, "const x = 1;\nconst y = 2;\n");
    const result = await ipc.invoke("preview:readFile", filePath) as {
      ok: boolean;
      value?: { content: string; mime: string; truncated: boolean; base64?: string };
    };
    assert.ok(result.ok);
    assert.ok(result.value!.content.includes("const x"));
    assert.equal(result.value!.truncated, false);
    assert.ok(result.value!.mime.startsWith("text/") || result.value!.mime === "application/json");
  });

  it("reads a JSON file and returns text/plain or application/json mime", async () => {
    const filePath = join(tmpDir, "data.json");
    await writeFile(filePath, JSON.stringify({ hello: "world" }));
    const result = await ipc.invoke("preview:readFile", filePath) as {
      ok: boolean;
      value?: { content: string; mime: string; truncated: boolean };
    };
    assert.ok(result.ok);
    assert.ok(result.value!.content.includes("hello"));
  });

  it("returns base64 for PNG files", async () => {
    // Minimal 1x1 PNG (hardcoded bytes)
    const PNG_1x1 = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489" +
      "0000000a49444154789c6260000000020001e221bc330000000049454e44ae426082",
      "hex",
    );
    const filePath = join(tmpDir, "tiny.png");
    await writeFile(filePath, PNG_1x1);
    const result = await ipc.invoke("preview:readFile", filePath) as {
      ok: boolean;
      value?: { content: string; base64?: string; mime: string; truncated: boolean };
    };
    assert.ok(result.ok);
    assert.equal(result.value!.mime, "image/png");
    assert.ok(typeof result.value!.base64 === "string" && result.value!.base64.length > 0);
    assert.equal(result.value!.content, "");
  });

  it("truncates large text files at ~512 KB", async () => {
    const bigContent = "x".repeat(600 * 1024); // 600 KB
    const filePath = join(tmpDir, "big.txt");
    await writeFile(filePath, bigContent);
    const result = await ipc.invoke("preview:readFile", filePath) as {
      ok: boolean;
      value?: { content: string; mime: string; truncated: boolean };
    };
    assert.ok(result.ok);
    assert.equal(result.value!.truncated, true);
    assert.ok(result.value!.content.length <= 512 * 1024 + 100);
  });

  it("returns ok:false for a missing file", async () => {
    const result = await ipc.invoke("preview:readFile", join(tmpDir, "ghost.txt")) as {
      ok: boolean;
      error?: string;
    };
    assert.equal(result.ok, false);
    assert.ok(typeof result.error === "string");
  });

  it("returns ok:false for empty path", async () => {
    const result = await ipc.invoke("preview:readFile", "") as { ok: boolean };
    assert.equal(result.ok, false);
  });

  it("reads a markdown file as text with text/plain mime", async () => {
    const filePath = join(tmpDir, "README.md");
    await writeFile(filePath, "# Hello\n\nWorld\n");
    const result = await ipc.invoke("preview:readFile", filePath) as {
      ok: boolean;
      value?: { content: string; mime: string; truncated: boolean };
    };
    assert.ok(result.ok);
    assert.ok(result.value!.content.includes("Hello"));
    assert.equal(result.value!.truncated, false);
  });
});
