/**
 * Plugin contribution discovery.
 *
 * Scans a plugin root directory for:
 *   - skills/           SKILL.md files (one per subdirectory)
 *   - agents/           *.md subagent files
 *   - commands/         legacy flat *.md command files
 *   - .mcp.json         MCP server configuration
 *   - hooks/hooks.json  lifecycle hooks
 *
 * Malformed individual items are skipped with a recorded warning; they are
 * never fatal. Only the plugin root being unreadable is an error.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { SkillFileMeta } from "../skills/index.ts";
import type { SubagentFileMeta } from "../agent/subagents.ts";
import { parseSkillFile } from "../skills/index.ts";
import { parseSubagentFile } from "../agent/subagents.ts";

/* ------------------------------------------------------------- result --- */

export interface DiscoveryWarning {
  path: string;
  reason: string;
}

export interface DiscoveryResult {
  skills: SkillFileMeta[];
  agents: SubagentFileMeta[];
  /** Legacy flat command names (filename without .md). */
  commands: string[];
  /** Parsed MCP server configs from .mcp.json. */
  mcpServers: McpServerEntry[];
  /** Whether hooks/hooks.json is present (we don't validate the shape). */
  hasHooks: boolean;
  warnings: DiscoveryWarning[];
}

export interface McpServerEntry {
  id: string;
  name: string;
  transport: string;
  /** http/sse URL */
  url?: string;
  /** stdio command */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

/* ------------------------------------------------------- main export --- */

/**
 * Discover all contributions inside a plugin root directory.
 * Never throws; malformed items are recorded as warnings.
 */
export async function discoverContributions(pluginDir: string): Promise<DiscoveryResult> {
  const result: DiscoveryResult = {
    skills: [],
    agents: [],
    commands: [],
    mcpServers: [],
    hasHooks: false,
    warnings: [],
  };

  /* --------------------------------------------------- skills/ dir --- */
  const skillsDir = join(pluginDir, "skills");
  try {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = join(skillsDir, entry.name, "SKILL.md");
      try {
        const s = await stat(skillPath);
        if (!s.isFile()) continue;
        const text = await readFile(skillPath, "utf-8");
        const meta = parseSkillFile(text, skillPath);
        if (!meta.name) {
          result.warnings.push({
            path: skillPath,
            reason: 'Missing required field "name" in SKILL.md frontmatter.',
          });
          continue;
        }
        result.skills.push(meta);
      } catch (e) {
        // File missing or unreadable — skip silently (SKILL.md just doesn't exist)
        const msg = e instanceof Error ? e.message : String(e);
        // Only warn if the file existed but failed to parse
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          result.warnings.push({ path: skillPath, reason: msg });
        }
      }
    }
  } catch {
    // skills/ dir doesn't exist — that's fine
  }

  /* --------------------------------------------------- agents/ dir --- */
  const agentsDir = join(pluginDir, "agents");
  try {
    const entries = await readdir(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const agentPath = join(agentsDir, entry.name);
      try {
        const text = await readFile(agentPath, "utf-8");
        const meta = parseSubagentFile(text, agentPath);
        if (!meta.name) {
          result.warnings.push({
            path: agentPath,
            reason: 'Missing required field "name" in agent frontmatter.',
          });
          continue;
        }
        result.agents.push(meta);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        result.warnings.push({ path: agentPath, reason: msg });
      }
    }
  } catch {
    // agents/ dir doesn't exist — fine
  }

  /* ------------------------------------------------- commands/ dir --- */
  const commandsDir = join(pluginDir, "commands");
  try {
    const entries = await readdir(commandsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const cmdName = entry.name.slice(0, -3); // strip .md
      if (cmdName) result.commands.push(cmdName);
    }
  } catch {
    // commands/ dir doesn't exist — fine
  }

  /* ---------------------------------------------------- .mcp.json --- */
  const mcpPath = join(pluginDir, ".mcp.json");
  try {
    const text = await readFile(mcpPath, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.warnings.push({ path: mcpPath, reason: `Invalid JSON: ${msg}` });
      parsed = null;
    }
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      // Support both { mcpServers: { name: {...} } } and { servers: [...] } formats
      const servers = obj["mcpServers"] ?? obj["servers"];
      if (typeof servers === "object" && servers !== null && !Array.isArray(servers)) {
        // Object map: { serverName: { transport, url/command, ... } }
        for (const [id, cfg] of Object.entries(servers as Record<string, unknown>)) {
          const entry = parseMcpEntry(id, cfg, mcpPath, result.warnings);
          if (entry) result.mcpServers.push(entry);
        }
      } else if (Array.isArray(servers)) {
        for (const item of servers) {
          if (typeof item === "object" && item !== null) {
            const cfg = item as Record<string, unknown>;
            const id = typeof cfg["id"] === "string" ? cfg["id"] : typeof cfg["name"] === "string" ? cfg["name"] : "unknown";
            const entry = parseMcpEntry(id, item, mcpPath, result.warnings);
            if (entry) result.mcpServers.push(entry);
          }
        }
      }
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      const msg = e instanceof Error ? e.message : String(e);
      result.warnings.push({ path: mcpPath, reason: msg });
    }
  }

  /* ---------------------------------------------- hooks/hooks.json --- */
  const hooksPath = join(pluginDir, "hooks", "hooks.json");
  try {
    const s = await stat(hooksPath);
    result.hasHooks = s.isFile();
  } catch {
    result.hasHooks = false;
  }

  return result;
}

/* ------------------------------------------- MCP entry parser helper --- */

function parseMcpEntry(
  id: string,
  raw: unknown,
  sourcePath: string,
  warnings: DiscoveryWarning[],
): McpServerEntry | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push({ path: sourcePath, reason: `MCP server entry "${id}" is not an object.` });
    return null;
  }
  const cfg = raw as Record<string, unknown>;
  const name = typeof cfg["name"] === "string" ? cfg["name"] : id;
  const transport = typeof cfg["transport"] === "string" ? cfg["transport"] : "stdio";
  const url = typeof cfg["url"] === "string" ? cfg["url"] : undefined;
  const command = typeof cfg["command"] === "string" ? cfg["command"] : undefined;
  const args = Array.isArray(cfg["args"]) ? cfg["args"].filter((a) => typeof a === "string") as string[] : undefined;
  const env =
    cfg["env"] !== null && typeof cfg["env"] === "object" && !Array.isArray(cfg["env"])
      ? (cfg["env"] as Record<string, string>)
      : undefined;

  return {
    id,
    name,
    transport,
    ...(url ? { url } : {}),
    ...(command ? { command } : {}),
    ...(args ? { args } : {}),
    ...(env ? { env } : {}),
  };
}
