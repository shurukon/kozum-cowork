/**
 * Integration tests for:
 *  - ProjectStore (create/list/update/archive/remove round trip)
 *  - ProjectStore validation (non-existent folder, file path)
 *  - dialog:selectFolder / dialog:selectFiles IPC handlers
 *  - mcp:add with authToken — raw token absent from persisted JSON and returned object
 *
 * Run with:
 *   node --experimental-strip-types --test tests/integration/projects-dialog.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectStore } from "../../src/main/store/projects.ts";
import { registerIpc } from "../../src/main/ipc/index.ts";
import type { DialogFacade, IpcDeps } from "../../src/main/ipc/index.ts";
import type { McpServerConfig } from "../../src/shared/types.ts";

/* ================================================================ helpers === */

let tmpRoot = "";

before(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "kozum-proj-dialog-"));
});

after(async () => {
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
});

function tmpDir(name: string): string {
  return join(tmpRoot, name);
}

/* ----------------------------------------------------------------
   Minimal fakes for IpcDeps fields we do not test here.
---------------------------------------------------------------- */

function makeFakeIpcMain(): {
  handlers: Map<string, (_e: unknown, ...args: unknown[]) => Promise<unknown>>;
  handle: (channel: string, fn: (_e: unknown, ...args: unknown[]) => Promise<unknown>) => void;
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
} {
  const handlers = new Map<string, (_e: unknown, ...args: unknown[]) => Promise<unknown>>();
  return {
    handlers,
    handle(channel, fn) {
      handlers.set(channel, fn);
    },
    async invoke(channel, ...args) {
      const h = handlers.get(channel);
      if (!h) throw new Error(`No handler for channel: ${channel}`);
      return h(null, ...args);
    },
  };
}

/** Fake dialog that returns a preset value or cancel. */
function makeDialogFake(opts: {
  folder?: string | null;
  files?: string[];
}): DialogFacade {
  return {
    async showOpenDialog(options) {
      const isDir = options.properties.includes("openDirectory");
      if (isDir) {
        if (opts.folder == null) {
          return { canceled: true, filePaths: [] };
        }
        return { canceled: false, filePaths: [opts.folder] };
      }
      // file picker
      const paths = opts.files ?? [];
      return { canceled: paths.length === 0, filePaths: paths };
    },
  };
}

/** Minimal MCP manager stub used to test mcp:add token handling. */
function makeMcpStub() {
  const added: McpServerConfig[] = [];
  const connectCalls: { id: string; authToken?: string }[] = [];

  return {
    added,
    connectCalls,
    manager: {
      add(cfg: McpServerConfig) {
        added.push(cfg);
      },
      async connect(id: string, opts: { authToken?: string } = {}) {
        connectCalls.push({ id, authToken: opts.authToken });
      },
      status() {
        return added.map((c) => ({ ...c }));
      },
      async remove() { /* noop */ },
      enable() { /* noop */ },
      async disable() { /* noop */ },
      allTools() { return []; },
      async callTool() { return { ok: false, content: "", isError: true }; },
      async connectAll() { /* noop */ },
      getEntry() { return undefined; },
    },
  };
}

/** Build a full IpcDeps with a real ProjectStore and fake everything else. */
async function makeDeps(
  dir: string,
  dialogFake: DialogFacade,
): Promise<{
  ipc: ReturnType<typeof makeFakeIpcMain>;
  projectStore: ProjectStore;
  mcpStub: ReturnType<typeof makeMcpStub>;
}> {
  await mkdir(dir, { recursive: true });
  const projPath = join(dir, "projects.json");
  const projectStore = new ProjectStore(projPath);
  const mcpStub = makeMcpStub();

  const ipc = makeFakeIpcMain();

  // Build a minimal IpcDeps; the test only exercises dialog, projects, and mcp:add.
  const deps = {
    ipcMain: ipc as unknown as IpcDeps["ipcMain"],
    app: {} as IpcDeps["app"],
    getWindow: () => null,
    isDev: false,
    userDataPath: dir,
    settings: {} as IpcDeps["settings"],
    secrets: {} as IpcDeps["secrets"],
    registry: {} as IpcDeps["registry"],
    sessions: {} as IpcDeps["sessions"],
    sessionManager: {} as IpcDeps["sessionManager"],
    scheduler: {
      list: async () => [],
      add: () => { throw new Error("stub"); },
      update: () => null,
      remove: () => false,
      start: async () => { /* noop */ },
    } as unknown as IpcDeps["scheduler"],
    mcp: mcpStub.manager as unknown as IpcDeps["mcp"],
    plugins: {
      list: async () => [],
      enable: async () => { /* noop */ },
      disable: async () => { /* noop */ },
      uninstall: async () => { /* noop */ },
      installFromGitHub: async () => { throw new Error("stub"); },
    } as unknown as IpcDeps["plugins"],
    skills: {
      list: () => [],
    } as unknown as IpcDeps["skills"],
    tasks: {
      list: () => [],
    } as unknown as IpcDeps["tasks"],
    projects: projectStore,
    dialog: dialogFake,
  } satisfies IpcDeps;

  registerIpc(deps);
  return { ipc, projectStore, mcpStub };
}

/* ================================================================ ProjectStore unit === */

describe("ProjectStore — create/list/update/archive/remove round trip", () => {
  it("create persists a project with the given fields", async () => {
    const dir = tmpDir("ps-create");
    await mkdir(dir, { recursive: true });
    const realFolder = tmpDir("ps-create-folder");
    await mkdir(realFolder, { recursive: true });

    const store = new ProjectStore(join(dir, "projects.json"));
    const result = await store.create({ name: "My Project", folder: realFolder, mode: "cowork" });
    assert.ok(result.ok, "create should succeed");
    if (!result.ok) return;

    assert.equal(result.value.name, "My Project");
    assert.equal(result.value.folder, realFolder);
    assert.equal(result.value.mode, "cowork");
    assert.equal(result.value.archived, false);
    assert.ok(result.value.id.startsWith("proj_"), "id should start with proj_");
  });

  it("list returns only non-archived projects", async () => {
    const dir = tmpDir("ps-list");
    await mkdir(dir, { recursive: true });
    const f1 = tmpDir("ps-list-f1");
    const f2 = tmpDir("ps-list-f2");
    await mkdir(f1, { recursive: true });
    await mkdir(f2, { recursive: true });

    const store = new ProjectStore(join(dir, "projects.json"));
    const r1 = await store.create({ name: "P1", folder: f1, mode: "cowork" });
    const r2 = await store.create({ name: "P2", folder: f2, mode: "code" });
    assert.ok(r1.ok && r2.ok);
    if (!r1.ok || !r2.ok) return;

    await store.archive(r1.value.id);
    const list = await store.list();
    assert.equal(list.length, 1, "only non-archived projects in list");
    assert.equal(list[0]!.id, r2.value.id);
  });

  it("update patches the name without touching other fields", async () => {
    const dir = tmpDir("ps-update");
    await mkdir(dir, { recursive: true });
    const folder = tmpDir("ps-update-folder");
    await mkdir(folder, { recursive: true });

    const store = new ProjectStore(join(dir, "projects.json"));
    const cr = await store.create({ name: "Original", folder, mode: "cowork" });
    assert.ok(cr.ok);
    if (!cr.ok) return;

    const ur = await store.update(cr.value.id, { name: "Renamed" });
    assert.ok(ur.ok);
    if (!ur.ok) return;

    assert.equal(ur.value.name, "Renamed");
    assert.equal(ur.value.folder, folder, "folder unchanged");
    assert.equal(ur.value.mode, "cowork", "mode unchanged");
  });

  it("archive sets archived = true and persists", async () => {
    const dir = tmpDir("ps-archive");
    await mkdir(dir, { recursive: true });
    const folder = tmpDir("ps-archive-folder");
    await mkdir(folder, { recursive: true });

    const store = new ProjectStore(join(dir, "projects.json"));
    const cr = await store.create({ name: "ToArchive", folder, mode: "cowork" });
    assert.ok(cr.ok);
    if (!cr.ok) return;

    const ar = await store.archive(cr.value.id);
    assert.ok(ar.ok);
    if (!ar.ok) return;
    assert.equal(ar.value.archived, true);

    // Reload from disk
    const store2 = new ProjectStore(join(dir, "projects.json"));
    const reloaded = await store2.get(cr.value.id);
    assert.ok(reloaded !== null);
    assert.equal(reloaded!.archived, true);
  });

  it("remove deletes the project record from disk", async () => {
    const dir = tmpDir("ps-remove");
    await mkdir(dir, { recursive: true });
    const folder = tmpDir("ps-remove-folder");
    await mkdir(folder, { recursive: true });

    const store = new ProjectStore(join(dir, "projects.json"));
    const cr = await store.create({ name: "ToRemove", folder, mode: "cowork" });
    assert.ok(cr.ok);
    if (!cr.ok) return;

    const rr = await store.remove(cr.value.id);
    assert.ok(rr.ok);

    const store2 = new ProjectStore(join(dir, "projects.json"));
    const reloaded = await store2.get(cr.value.id);
    assert.equal(reloaded, null, "project should be gone after remove");
  });

  it("persists across a fresh store instance", async () => {
    const dir = tmpDir("ps-persist");
    await mkdir(dir, { recursive: true });
    const folder = tmpDir("ps-persist-folder");
    await mkdir(folder, { recursive: true });

    const path = join(dir, "projects.json");
    const store1 = new ProjectStore(path);
    const cr = await store1.create({ name: "Persisted", folder, mode: "code" });
    assert.ok(cr.ok);
    if (!cr.ok) return;

    const store2 = new ProjectStore(path);
    const list = await store2.list();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.name, "Persisted");
  });
});

/* ================================================================ ProjectStore validation === */

describe("ProjectStore — validation", () => {
  it("create rejects a non-existent folder", async () => {
    const dir = tmpDir("ps-val-nonexistent");
    await mkdir(dir, { recursive: true });

    const store = new ProjectStore(join(dir, "projects.json"));
    const result = await store.create({
      name: "Bad",
      folder: join(dir, "does-not-exist"),
      mode: "cowork",
    });
    assert.ok(!result.ok, "should fail");
    assert.ok(
      result.ok === false && /does not exist/i.test(result.error),
      `error should mention non-existence, got: ${result.ok === false ? result.error : ""}`,
    );
  });

  it("create rejects a path that is a file, not a directory", async () => {
    const dir = tmpDir("ps-val-file");
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, "notadir.txt");
    await writeFile(filePath, "hello");

    const store = new ProjectStore(join(dir, "projects.json"));
    const result = await store.create({
      name: "Bad",
      folder: filePath,
      mode: "cowork",
    });
    assert.ok(!result.ok, "should fail");
    assert.ok(
      result.ok === false && /not a directory/i.test(result.error),
      `error should mention not a directory, got: ${result.ok === false ? result.error : ""}`,
    );
  });

  it("archive returns an error for an unknown id", async () => {
    const dir = tmpDir("ps-val-archive-unknown");
    await mkdir(dir, { recursive: true });
    const store = new ProjectStore(join(dir, "projects.json"));
    const result = await store.archive("proj_nonexistent");
    assert.ok(!result.ok);
  });

  it("remove returns an error for an unknown id", async () => {
    const dir = tmpDir("ps-val-remove-unknown");
    await mkdir(dir, { recursive: true });
    const store = new ProjectStore(join(dir, "projects.json"));
    const result = await store.remove("proj_nonexistent");
    assert.ok(!result.ok);
  });
});

/* ================================================================ dialog handlers === */

describe("dialog IPC handlers", () => {
  it("dialog:selectFolder returns the injected folder path", async () => {
    const dir = tmpDir("dlg-folder");
    const fakeFolder = tmpDir("dlg-folder-fake");
    const { ipc } = await makeDeps(dir, makeDialogFake({ folder: fakeFolder }));

    const result = await ipc.invoke("dialog:selectFolder");
    assert.equal(result, fakeFolder);
  });

  it("dialog:selectFolder returns null when cancelled", async () => {
    const dir = tmpDir("dlg-folder-cancel");
    const { ipc } = await makeDeps(dir, makeDialogFake({ folder: null }));

    const result = await ipc.invoke("dialog:selectFolder");
    assert.equal(result, null);
  });

  it("dialog:selectFiles returns the injected file paths", async () => {
    const dir = tmpDir("dlg-files");
    const fakePaths = ["/a/b/c.txt", "/a/b/d.txt"];
    const { ipc } = await makeDeps(dir, makeDialogFake({ files: fakePaths }));

    const result = await ipc.invoke("dialog:selectFiles");
    assert.deepEqual(result, fakePaths);
  });

  it("dialog:selectFiles returns an empty array when cancelled", async () => {
    const dir = tmpDir("dlg-files-cancel");
    const { ipc } = await makeDeps(dir, makeDialogFake({ files: [] }));

    const result = await ipc.invoke("dialog:selectFiles");
    assert.deepEqual(result, []);
  });
});

/* ================================================================ mcp:add token handling === */

describe("mcp:add — authToken security", () => {
  it("raw authToken is NOT present in the object returned to the renderer", async () => {
    const dir = tmpDir("mcp-token-return");
    const { ipc } = await makeDeps(dir, makeDialogFake({}));

    const payload = {
      name: "TestServer",
      enabled: true,
      transport: "http" as const,
      url: "https://example.com/mcp",
      hasAuthToken: false,
      authHeader: undefined,
      command: undefined,
      args: undefined,
      env: undefined,
      installedByAgent: false,
      allowLocal: false,
      authToken: "super-secret-token-abc123",
    };

    const result = await ipc.invoke("mcp:add", payload);
    // Result is { ok: true, value: McpServerConfig }
    const res = result as { ok: boolean; value: Record<string, unknown> };
    assert.ok(res.ok, "mcp:add should succeed");

    const returned = res.value;
    assert.ok(
      !("authToken" in returned),
      "returned object must not contain authToken field",
    );
    assert.ok(
      JSON.stringify(returned).indexOf("super-secret-token-abc123") === -1,
      "raw token must not appear anywhere in returned value",
    );
    assert.equal(returned["hasAuthToken"], true, "hasAuthToken should be true");
  });

  it("raw authToken is NOT written to the persisted mcp config (McpManager.add receives sanitised config)", async () => {
    const dir = tmpDir("mcp-token-persist");
    const { ipc, mcpStub } = await makeDeps(dir, makeDialogFake({}));

    const secretToken = "very-secret-token-xyz987";
    const payload = {
      name: "PersistServer",
      enabled: true,
      transport: "http" as const,
      url: "https://example.com/mcp",
      hasAuthToken: false,
      authHeader: undefined,
      command: undefined,
      args: undefined,
      env: undefined,
      installedByAgent: false,
      allowLocal: false,
      authToken: secretToken,
    };

    await ipc.invoke("mcp:add", payload);

    // The config added to the McpManager (which represents what would be persisted)
    // must not contain the raw token.
    assert.equal(mcpStub.added.length, 1, "one server should have been added");
    const addedConfig = mcpStub.added[0]!;

    // Check the serialised form as JSON (mirrors what McpManager would write to mcp.json)
    const serialised = JSON.stringify(addedConfig);
    assert.ok(
      serialised.indexOf(secretToken) === -1,
      `raw token must not appear in persisted config JSON, got: ${serialised}`,
    );
    assert.ok(
      !("authToken" in addedConfig),
      "persisted config object must not have an authToken field",
    );
    assert.equal(addedConfig.hasAuthToken, true, "hasAuthToken should be true in persisted config");
  });

  it("authToken is passed in-memory to mcp.connect() but not persisted", async () => {
    const dir = tmpDir("mcp-token-connect");
    const { ipc, mcpStub } = await makeDeps(dir, makeDialogFake({}));

    const secretToken = "connect-token-abc456";
    const payload = {
      name: "ConnectServer",
      enabled: true,
      transport: "http" as const,
      url: "https://example.com/mcp",
      hasAuthToken: false,
      authHeader: undefined,
      command: undefined,
      args: undefined,
      env: undefined,
      installedByAgent: false,
      allowLocal: false,
      authToken: secretToken,
    };

    await ipc.invoke("mcp:add", payload);

    // The connect call should have received the raw token (in memory only)
    assert.equal(mcpStub.connectCalls.length, 1);
    assert.equal(mcpStub.connectCalls[0]!.authToken, secretToken,
      "connect() should receive the raw token for the live connection");
  });

  it("mcp:add without authToken leaves hasAuthToken false when input says false", async () => {
    const dir = tmpDir("mcp-no-token");
    const { ipc, mcpStub } = await makeDeps(dir, makeDialogFake({}));

    const payload = {
      name: "NoTokenServer",
      enabled: true,
      transport: "stdio" as const,
      url: undefined,
      hasAuthToken: false,
      authHeader: undefined,
      command: "node",
      args: ["server.js"],
      env: undefined,
      installedByAgent: false,
      allowLocal: false,
    };

    const result = await ipc.invoke("mcp:add", payload);
    const res = result as { ok: boolean; value: Record<string, unknown> };
    assert.ok(res.ok);
    assert.equal(res.value["hasAuthToken"], false);
    assert.equal(mcpStub.added[0]!.hasAuthToken, false);
  });
});

/* ================================================================ projects IPC handlers === */

describe("projects IPC handlers", () => {
  it("projects:create and projects:list round trip via IPC", async () => {
    const dir = tmpDir("proj-ipc-rt");
    const folder = tmpDir("proj-ipc-rt-folder");
    await mkdir(folder, { recursive: true });
    const { ipc } = await makeDeps(dir, makeDialogFake({}));

    const cr = await ipc.invoke("projects:create", {
      name: "IPC Project",
      folder,
      mode: "cowork",
    });
    const crRes = cr as { ok: boolean; value: { id: string; name: string } };
    assert.ok(crRes.ok, "create should succeed via IPC");
    assert.equal(crRes.value.name, "IPC Project");

    const list = await ipc.invoke("projects:list");
    const listArr = list as Array<{ id: string }>;
    assert.equal(listArr.length, 1);
    assert.equal(listArr[0]!.id, crRes.value.id);
  });

  it("projects:create returns an error for a non-existent folder via IPC", async () => {
    const dir = tmpDir("proj-ipc-baddir");
    await mkdir(dir, { recursive: true });
    const { ipc } = await makeDeps(dir, makeDialogFake({}));

    const cr = await ipc.invoke("projects:create", {
      name: "Bad",
      folder: join(dir, "no-such-dir"),
      mode: "cowork",
    });
    const crRes = cr as { ok: boolean; error?: string };
    assert.ok(!crRes.ok, "create should fail for non-existent folder");
  });

  it("projects:archive via IPC marks the project archived", async () => {
    const dir = tmpDir("proj-ipc-archive");
    const folder = tmpDir("proj-ipc-archive-folder");
    await mkdir(folder, { recursive: true });
    const { ipc } = await makeDeps(dir, makeDialogFake({}));

    const cr = await ipc.invoke("projects:create", { name: "Arch", folder, mode: "cowork" });
    const crRes = cr as { ok: boolean; value: { id: string } };
    assert.ok(crRes.ok);

    const ar = await ipc.invoke("projects:archive", crRes.value.id);
    const arRes = ar as { ok: boolean; value: { archived: boolean } };
    assert.ok(arRes.ok);
    assert.equal(arRes.value.archived, true);
  });

  it("projects:remove via IPC deletes the project", async () => {
    const dir = tmpDir("proj-ipc-remove");
    const folder = tmpDir("proj-ipc-remove-folder");
    await mkdir(folder, { recursive: true });
    const { ipc } = await makeDeps(dir, makeDialogFake({}));

    const cr = await ipc.invoke("projects:create", { name: "Del", folder, mode: "cowork" });
    const crRes = cr as { ok: boolean; value: { id: string } };
    assert.ok(crRes.ok);

    const rr = await ipc.invoke("projects:remove", crRes.value.id);
    assert.ok((rr as { ok: boolean }).ok);

    const list = await ipc.invoke("projects:list");
    assert.deepEqual(list, []);
  });

  it("projects:update patches a field via IPC", async () => {
    const dir = tmpDir("proj-ipc-update");
    const folder = tmpDir("proj-ipc-update-folder");
    await mkdir(folder, { recursive: true });
    const { ipc } = await makeDeps(dir, makeDialogFake({}));

    const cr = await ipc.invoke("projects:create", { name: "Before", folder, mode: "cowork" });
    const crRes = cr as { ok: boolean; value: { id: string } };
    assert.ok(crRes.ok);

    const ur = await ipc.invoke("projects:update", crRes.value.id, { name: "After" });
    const urRes = ur as { ok: boolean; value: { name: string } };
    assert.ok(urRes.ok);
    assert.equal(urRes.value.name, "After");
  });
});

/* ================================================================ disk content verify === */

describe("mcp:add — disk / JSON content", () => {
  it("the projects.json file created by ProjectStore does not contain any raw token", async () => {
    // This verifies the contract at the serialisation level.
    const dir = tmpDir("mcp-disk-check");
    await mkdir(dir, { recursive: true });
    const folder = tmpDir("mcp-disk-check-folder");
    await mkdir(folder, { recursive: true });

    const projPath = join(dir, "projects.json");
    const store = new ProjectStore(projPath);

    // Create a project (exercises writeJson path)
    await store.create({ name: "safe", folder, mode: "cowork" });

    const raw = await readFile(projPath, "utf-8");
    // There is nothing sensitive here, but confirm authToken-like strings are absent.
    assert.ok(
      raw.indexOf("authToken") === -1,
      "projects.json must not contain 'authToken'",
    );
  });
});
