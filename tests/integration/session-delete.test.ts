import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { SettingsStore } from "../../src/main/store/settings.ts";
import { SecretStore } from "../../src/main/store/secrets.ts";
import type { SafeStorageFacade } from "../../src/main/store/secrets.ts";
import { ProviderRegistry } from "../../src/main/providers/registry.ts";
import { SessionStore } from "../../src/main/session/store.ts";
import { SessionManager } from "../../src/main/session/manager.ts";
import { MemoryVault } from "../../src/main/memory/vault.ts";
import { SkillStore } from "../../src/main/skills/index.ts";
import { McpManager } from "../../src/main/mcp/manager.ts";
import { AskBroker } from "../../src/main/tools/ask.ts";
import { TaskStore } from "../../src/main/tools/tasks.ts";
import { ToolRegistry } from "../../src/main/tools/registry.ts";
import type { AgentEvent } from "../../src/shared/types.ts";
import { freshSettings } from "../../src/shared/defaults.ts";

const sse = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const done = "data: [DONE]\n\n";

function encryptor(): SafeStorageFacade {
  const key = 0xa5;
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => {
      const buffer = Buffer.from(value, "utf8");
      for (let index = 0; index < buffer.length; index += 1) buffer[index] = buffer[index]! ^ key;
      return buffer;
    },
    decryptString: (value) => {
      const buffer = Buffer.from(value);
      for (let index = 0; index < buffer.length; index += 1) buffer[index] = buffer[index]! ^ key;
      return buffer.toString("utf8");
    },
  };
}

function appPaths(base: string): { getPath: (name: "appData") => string } {
  return { getPath: () => base };
}

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started >= timeoutMs) {
        clearInterval(timer);
        reject(new Error("Timed out waiting for test condition"));
      }
    }, 10);
  });
}

describe("session deletion while an agent loop is running", () => {
  let root: string;
  let server: http.Server;
  let baseUrl: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "kozum-session-delete-"));
    server = http.createServer((req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      // Send a real provider delta immediately, then keep the response open.
      // The test's teardown must abort this request before the delayed finish.
      res.write(sse({ choices: [{ delta: { content: "started" } }] }));
      const timer = setTimeout(() => {
        res.write(sse({ choices: [{ delta: {}, finish_reason: "stop" }] }));
        res.end(done);
      }, 5000);
      req.on("aborted", () => clearTimeout(timer));
      res.on("close", () => clearTimeout(timer));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  it("teardown then delete stops the loop and leaves no late events or session files", async () => {
    const secrets = new SecretStore(join(root, "keys.json"), encryptor());
    const registry = new ProviderRegistry(secrets, appPaths(root));
    const originalContextFor = registry.contextFor.bind(registry);
    registry.contextFor = async (providerId, keyId) => ({
      ...(await originalContextFor(providerId, keyId)),
      baseUrl,
    });
    const settings = new SettingsStore(join(root, "settings.json"));
    const key = await secrets.add("openai", "test", "sk-session-delete");
    const defaults = freshSettings();
    await settings.patch({
      cowork: {
        ...defaults.cowork,
        selection: { providerId: "openai", keyId: key.id, modelId: "gpt-4o" },
      },
    });

    const sessions = new SessionStore(join(root, "sessions"));
    const ask = new AskBroker();
    const events: AgentEvent[] = [];
    const manager = new SessionManager({
      sessions,
      registry,
      settings,
      memory: new MemoryVault(join(root, "memory")),
      skills: new SkillStore(),
      mcp: new McpManager(),
      ask,
      tasks: new TaskStore(),
      toolRegistry: new ToolRegistry(),
      emitEvent: (_sessionId, event) => events.push(event),
    });
    const session = await sessions.create("cowork", {
      providerId: "openai",
      keyId: key.id,
      modelId: "gpt-4o",
    });

    const sendResult = await manager.send(session.id, "Start a long running task");
    assert.equal(sendResult.ok, true);
    await waitFor(() => events.some((event) => event.type === "text_delta"));
    const eventCountAtDelete = events.length;

    const teardownResult = await manager.teardown(session.id);
    assert.equal(teardownResult.ok, true);
    assert.equal((await sessions.delete(session.id)), true);
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.equal(events.length, eventCountAtDelete, "no event may arrive after teardown/delete");
    assert.equal(await sessions.get(session.id), null);
    await assert.rejects(() => stat(join(root, "sessions", session.id)));
    const retry = await manager.send(session.id, "late retry");
    assert.equal(retry.ok, false);
    assert.match(retry.error, /not found|closed/i);
  });
});
