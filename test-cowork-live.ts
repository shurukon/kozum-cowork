import { join } from "node:path";
import { SecretStore, type SafeStorageFacade } from "./src/main/store/secrets.ts";
import { SettingsStore } from "./src/main/store/settings.ts";
import { ProviderRegistry } from "./src/main/providers/registry.ts";
import { SessionStore } from "./src/main/session/store.ts";
import { SessionManager } from "./src/main/session/manager.ts";
import { MemoryVault } from "./src/main/memory/vault.ts";
import { SkillStore } from "./src/main/skills/index.ts";
import { McpManager } from "./src/main/mcp/manager.ts";
import { AskBroker } from "./src/main/tools/ask.ts";
import { TaskStore } from "./src/main/tools/tasks.ts";
import { ToolRegistry } from "./src/main/tools/registry.ts";

/** A fake safeStorage for environments where Electron isn't available. */
function makeFakeEncryptor(): SafeStorageFacade {
  const KEY = 0xaa;
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => {
      const buf = Buffer.from(s, "utf-8");
      for (let i = 0; i < buf.length; i++) buf[i] = buf[i]! ^ KEY;
      return buf;
    },
    decryptString: (buf: Buffer) => {
      const out = Buffer.from(buf);
      for (let i = 0; i < out.length; i++) out[i] = out[i]! ^ KEY;
      return out.toString("utf-8");
    },
  };
}

async function testLiveCowork() {
  const baseDir = join(process.env.APPDATA || process.cwd(), "Kozum");
  console.log("Loading stores from:", baseDir);

  const secrets = new SecretStore(join(baseDir, "keys.json"), makeFakeEncryptor());
  const settings = new SettingsStore(join(baseDir, "settings.json"));
  const registry = new ProviderRegistry(secrets, { getPath: () => baseDir });
  const sessions = new SessionStore(join(baseDir, "sessions"));
  const memory = new MemoryVault(join(baseDir, "memory"));
  await memory.init();
  const skills = new SkillStore();
  const mcp = new McpManager();
  const ask = new AskBroker();
  const tasks = new TaskStore();
  const toolRegistry = new ToolRegistry();

  const manager = new SessionManager({
    sessions,
    settings,
    registry,
    memory,
    skills,
    mcp,
    ask,
    tasks,
    toolRegistry,
    emitEvent: (_sid, evt) => {
      if (evt.type === "turn_start") console.log("\n[EVENT] turn_start:", evt.messageId);
      if (evt.type === "text_delta") process.stdout.write(evt.delta);
      if (evt.type === "turn_end") console.log("\n[EVENT] turn_end:", evt.stopReason);
      if (evt.type === "error") console.error("\n[EVENT] error:", evt.message);
    },
  });

  const appSettings = await settings.get();
  console.log("Cowork Selection:", appSettings.cowork.selection);

  const session = await sessions.create("cowork", appSettings.cowork.selection);
  console.log("Created test Cowork session ID:", session.id);

  console.log("Sending test message to Cowork mode...");
  const sendRes = await manager.send(session.id, "Hello! Reply with a 1-sentence confirmation that Cowork mode is working.");
  console.log("Send Result:", sendRes);

  // Wait 15 seconds for stream to complete
  await new Promise((r) => setTimeout(r, 15000));
  const msgs = await sessions.messages(session.id);
  console.log("\nFinal Session Messages Count:", msgs.length);
  for (const m of msgs) {
    console.log(`- [${m.role}]`, JSON.stringify(m.content));
  }
}

testLiveCowork().catch((e) => console.error("Error running test:", e));
