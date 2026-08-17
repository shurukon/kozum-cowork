import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildToolRegistry } from "../src/main/tools/index.ts";
import { TaskStore } from "../src/main/tools/tasks.ts";
import { AskBroker } from "../src/main/tools/ask.ts";
import { SubagentManager } from "../src/main/agent/subagents.ts";
import { SkillStore } from "../src/main/skills/index.ts";
import { MemoryVault } from "../src/main/memory/vault.ts";
import { Scheduler } from "../src/main/schedule/scheduler.ts";
import { McpManager } from "../src/main/mcp/manager.ts";
import { PluginManager } from "../src/main/plugins/manager.ts";
import { BrowserEngine, ElectronBrowserBackend } from "../src/main/browser/engine.ts";

const root = await mkdtemp(join(tmpdir(), "kozum-tool-inventory-"));
try {
  const memory = new MemoryVault(join(root, "memory"));
  await memory.init();
  const services = {
    tasks: new TaskStore(),
    ask: new AskBroker(),
    subagents: new SubagentManager(async () => undefined),
    skills: new SkillStore(),
    memory,
    scheduler: new Scheduler({ rootDir: join(root, "scheduler"), runner: async () => undefined }),
    mcp: new McpManager(),
    plugins: new PluginManager(join(root, "plugins")),
    browser: new BrowserEngine(new ElectronBrowserBackend()),
    getComputerBlocklist: () => [],
  };
  const registry = buildToolRegistry(services);
  const tools = registry.list("cowork");
  console.log(JSON.stringify({
    count: tools.length,
    names: tools.map((tool) => tool.name),
    definitions: tools.map((tool) => ({ name: tool.name, group: tool.group, description: tool.description, modes: tool.modes, inputSchema: tool.inputSchema })),
  }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
