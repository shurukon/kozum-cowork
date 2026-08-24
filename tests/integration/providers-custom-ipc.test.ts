import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { IpcMainInvokeEvent } from "electron";

import { registerIpc } from "../../src/main/ipc/index.ts";
import { SecretStore } from "../../src/main/store/secrets.ts";
import type { SafeStorageFacade } from "../../src/main/store/secrets.ts";
import { SettingsStore } from "../../src/main/store/settings.ts";
import { McpManager } from "../../src/main/mcp/manager.ts";

class FakeIpcMain {
  private readonly handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>();

  handle(channel: string, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>): void {
    this.handlers.set(channel, fn);
  }

  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const fn = this.handlers.get(channel);
    if (!fn) throw new Error(`No handler for ${channel}`);
    return fn({} as IpcMainInvokeEvent, ...args);
  }
}

function encryptor(): SafeStorageFacade {
  const key = 0xa7;
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => {
      const bytes = Buffer.from(value, "utf8");
      for (let i = 0; i < bytes.length; i++) bytes[i] = bytes[i]! ^ key;
      return bytes;
    },
    decryptString: (value) => {
      const bytes = Buffer.from(value);
      for (let i = 0; i < bytes.length; i++) bytes[i] = bytes[i]! ^ key;
      return bytes.toString("utf8");
    },
  };
}

function makeDeps(ipc: FakeIpcMain, root: string, settings: SettingsStore, secrets: SecretStore, mcp: McpManager) {
  return {
    ipcMain: ipc as unknown as import("electron").IpcMain,
    app: { getVersion: () => "0.0.0-test" } as unknown as import("electron").App,
    getWindow: () => null,
    isDev: false,
    userDataPath: root,
    settings,
    secrets,
    registry: { testKey: async () => undefined, refreshModels: async () => [], listModels: async () => [] },
    sessions: {
      list: async () => [], get: async () => null, create: async () => ({}), archive: async () => false,
      delete: async () => false, branch: async () => null, rename: async () => false,
      setPermissionMode: async () => false, messages: async () => [], listRuns: async () => [],
      readRunEvents: async () => [],
    },
    sessionManager: {
      send: async () => ({ ok: false, error: "stub" }), cancel: async () => ({ ok: false, error: "stub" }),
      reply: async () => ({ ok: false, error: "stub" }), teardown: async () => ({ ok: true }),
    },
    scheduler: { list: () => [], add: () => ({}), update: () => null, remove: () => false },
    mcp,
    plugins: { list: () => [], enable: async () => undefined, disable: async () => undefined, uninstall: async () => undefined, installFromGitHub: async () => ({}) },
    skills: { list: () => [] },
    tasks: { list: async () => [] },
    projects: { list: async () => [], get: async () => null, create: async () => ({ ok: false, error: "stub" }), update: async () => ({ ok: false, error: "stub" }), archive: async () => ({ ok: false, error: "stub" }), remove: async () => ({ ok: false, error: "stub" }) },
    memory: { getRules: async () => "", setRules: async () => undefined },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  } as unknown as Parameters<typeof registerIpc>[0];
}

describe("custom provider IPC contract", () => {
  it("creates a full provider, manages multiple keys/models, and removes all data", async () => {
    const root = await mkdtemp(join(tmpdir(), "kozum-custom-provider-"));
    try {
      const settings = new SettingsStore(join(root, "settings.json"));
      const secrets = new SecretStore(join(root, "keys.json"), encryptor());
      const mcp = new McpManager(join(root, "mcp.json"));
      await mcp.load();
      const ipc = new FakeIpcMain();
      registerIpc(makeDeps(ipc, root, settings, secrets, mcp));

      const missing = await ipc.invoke("providers:addCustom", {
        name: "Incomplete",
        baseUrl: "https://example.invalid/v1",
        apiKey: "",
        modelId: "",
      }) as { ok: boolean; error?: string };
      assert.equal(missing.ok, false);
      assert.match(missing.error ?? "", /API key|Model ID/i);
      assert.equal((await settings.get()).customProviders.length, 0);

      const created = await ipc.invoke("providers:addCustom", {
        name: "Team Gateway",
        baseUrl: "https://gateway.example.test/v1/",
        apiKey: "first-secret",
        modelId: "team-large",
      }) as { ok: boolean; value?: { id: string; name: string; baseUrl: string; staticModels?: string[]; builtIn: boolean }; error?: string };
      assert.equal(created.ok, true, created.error);
      assert.equal(created.value?.name, "Team Gateway");
      assert.equal(created.value?.baseUrl, "https://gateway.example.test/v1");
      assert.deepEqual(created.value?.staticModels, ["team-large"]);
      assert.equal(created.value?.builtIn, false);

      const providerId = created.value!.id;
      const firstKeys = await secrets.list(providerId);
      assert.equal(firstKeys.length, 1);
      assert.equal(await secrets.reveal(firstKeys[0]!.id), "first-secret");

      const addedModel = await ipc.invoke("providers:addModel", providerId, "team-small") as { ok: boolean; value?: { staticModels?: string[] }; error?: string };
      assert.equal(addedModel.ok, true, addedModel.error);
      assert.deepEqual(addedModel.value?.staticModels, ["team-large", "team-small"]);

      const duplicateModel = await ipc.invoke("providers:addModel", providerId, "team-small") as { ok: boolean; error?: string };
      assert.equal(duplicateModel.ok, false);
      assert.match(duplicateModel.error ?? "", /already registered/i);

      const addedKey = await ipc.invoke("providers:addKey", providerId, "Backup", "second-secret") as { ok: boolean; error?: string };
      assert.equal(addedKey.ok, true, addedKey.error);
      assert.equal((await secrets.list(providerId)).length, 2);

      const fixed = await ipc.invoke("providers:updateCustom", providerId, { baseUrl: "https://changed.invalid" }) as { ok: boolean; error?: string };
      assert.equal(fixed.ok, false);
      assert.match(fixed.error ?? "", /fixed/i);

      const current = await settings.get();
      await settings.patch({ cowork: { ...current.cowork, selection: { providerId, keyId: firstKeys[0]!.id, modelId: "team-large" } } });
      const removed = await ipc.invoke("providers:removeCustom", providerId) as { ok: boolean; error?: string };
      assert.equal(removed.ok, true, removed.error);
      assert.equal((await settings.get()).customProviders.some((provider) => provider.id === providerId), false);
      assert.equal((await secrets.list(providerId)).length, 0);
      assert.equal((await settings.get()).cowork.selection.providerId, "");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
