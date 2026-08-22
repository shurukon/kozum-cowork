import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { IpcMainInvokeEvent } from "electron";

import { registerIpc } from "../../src/main/ipc/index.ts";
import { McpManager } from "../../src/main/mcp/manager.ts";

class FakeIpcMain {
  private readonly handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>();
  handle(channel: string, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>): void {
    this.handlers.set(channel, fn);
  }
  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const fn = this.handlers.get(channel);
    if (!fn) throw new Error(`No handler for channel: ${channel}`);
    return fn({} as IpcMainInvokeEvent, ...args);
  }
}

function rpc(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function makeDeps(ipc: FakeIpcMain, root: string, mcp: McpManager) {
  const result = {
    ipcMain: ipc as unknown as import("electron").IpcMain,
    app: { getVersion: () => "0.0.0-test" } as unknown as import("electron").App,
    getWindow: () => null,
    isDev: false,
    userDataPath: root,
    settings: { get: async () => ({ customProviders: [] }), patch: async () => ({}) },
    secrets: { list: async () => [], add: async () => ({}), remove: async () => false },
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
  };
  return result as unknown as Parameters<typeof registerIpc>[0];
}

describe("mcp:add IPC handshake contract", () => {
  let root: string;
  let server: http.Server;
  let url: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "kozum-mcp-ipc-"));
    server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!message.id) {
        res.writeHead(202);
        res.end();
        return;
      }
      let result: unknown;
      if (message.method === "initialize") {
        result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "ipc-proof", version: "1" } };
      } else if (message.method === "tools/list") {
        result = { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }] };
      } else {
        res.writeHead(404);
        res.end();
        return;
      }
      const body = JSON.stringify(rpc(message.id, result));
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) });
      res.end(body);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  it("requires a real handshake and persists only a connected server", async () => {
    const file = join(root, "success-mcp.json");
    const manager = new McpManager(file);
    await manager.load();
    const ipc = new FakeIpcMain();
    registerIpc(makeDeps(ipc, root, manager));

    const result = await ipc.invoke("mcp:add", {
      name: "ipc-proof",
      enabled: true,
      transport: "http",
      url,
      hasAuthToken: false,
      installedByAgent: false,
      allowLocal: true,
    }) as { ok: boolean; error?: string; value?: { status: string; toolCount: number } };
    assert.equal(result.ok, true, result.error);
    assert.equal(result.value?.status, "connected");
    assert.equal(result.value?.toolCount, 1);
    const persisted = JSON.parse(await readFile(file, "utf8")) as { servers: Array<{ name: string; status?: string }> };
    assert.equal(persisted.servers.length, 1);
    assert.equal(persisted.servers[0]?.name, "ipc-proof");
    assert.equal(persisted.servers[0]?.status, "disconnected", "runtime status is normalized on disk");
  });

  it("rejects a dead endpoint and does not persist it", async () => {
    const file = join(root, "dead-mcp.json");
    const manager = new McpManager(file);
    await manager.load();
    const ipc = new FakeIpcMain();
    registerIpc(makeDeps(ipc, root, manager));
    const deadServer = http.createServer();
    await new Promise<void>((resolve) => deadServer.listen(0, "127.0.0.1", () => resolve()));
    const deadPort = (deadServer.address() as AddressInfo).port;
    await new Promise<void>((resolve) => deadServer.close(() => resolve()));

    const result = await ipc.invoke("mcp:add", {
      name: "dead",
      enabled: true,
      transport: "http",
      url: `http://127.0.0.1:${deadPort}`,
      hasAuthToken: false,
      installedByAgent: false,
      allowLocal: true,
    }) as { ok: boolean; error?: string };
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /connect|fetch|refused|timeout|failed/i);
    assert.equal(manager.status().length, 0);
    let persisted: { servers: unknown[] } = { servers: [] };
    try {
      persisted = JSON.parse(await readFile(file, "utf8")) as { servers: unknown[] };
    } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
    }
    assert.equal(persisted.servers.length, 0);
  });

  it("rejects localhost before network access when allowLocal is false", async () => {
    const manager = new McpManager(join(root, "blocked-mcp.json"));
    await manager.load();
    const ipc = new FakeIpcMain();
    registerIpc(makeDeps(ipc, root, manager));
    const result = await ipc.invoke("mcp:add", {
      name: "blocked",
      enabled: true,
      transport: "http",
      url,
      hasAuthToken: false,
      installedByAgent: false,
      allowLocal: false,
    }) as { ok: boolean; error?: string };
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /SSRF|localhost|private/i);
    assert.equal(manager.status().length, 0);
  });
});
