/**
 * Skill tools — discover and invoke SKILL.md-based skills.
 *
 * SkillStore.discover(roots) walks each root for any-name/SKILL.md files, parsing
 * their frontmatter. Malformed files are skipped with a recorded warning;
 * they never throw.
 *
 * skill_invoke loads the SKILL.md body and returns it as the tool result so
 * the skill's instructions land in the model's context.
 */

import { readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import type { Skill } from "../../shared/types.ts";
import type { Tool } from "../tools/registry.ts";
import { ok, fail } from "../tools/registry.ts";
import { parseFrontmatter } from "../agent/frontmatter.ts";

/* --------------------------------------------------------- parseSkillFile */

export interface SkillFileMeta {
  name: string;
  description: string;
  whenToUse?: string;
  allowedTools?: string[];
  modes?: string[];
  body: string;
}

/**
 * Parse a SKILL.md file.
 * Frontmatter fields: name, description, when_to_use / whenToUse,
 * allowed-tools / allowedTools (comma list or inline array), modes.
 */
export function parseSkillFile(text: string, _path: string): SkillFileMeta {
  const { data, body } = parseFrontmatter(text);

  const name = typeof data["name"] === "string" ? data["name"].trim() : "";
  const description =
    typeof data["description"] === "string" ? data["description"].trim() : "";
  const whenToUse =
    typeof data["when_to_use"] === "string"
      ? data["when_to_use"].trim()
      : typeof data["whenToUse"] === "string"
      ? data["whenToUse"].trim()
      : undefined;

  const rawAllowed = data["allowed-tools"] ?? data["allowedTools"];
  let allowedTools: string[] | undefined;
  if (Array.isArray(rawAllowed)) {
    allowedTools = rawAllowed.map(String);
  } else if (typeof rawAllowed === "string" && rawAllowed.trim()) {
    allowedTools = rawAllowed
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const rawModes = data["modes"];
  let modes: string[] | undefined;
  if (Array.isArray(rawModes)) {
    modes = rawModes.map(String);
  } else if (typeof rawModes === "string" && rawModes.trim()) {
    modes = rawModes
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return {
    name,
    description,
    ...(whenToUse ? { whenToUse } : {}),
    ...(allowedTools !== undefined && allowedTools.length > 0 ? { allowedTools } : {}),
    ...(modes !== undefined && modes.length > 0 ? { modes } : {}),
    body: body.trim(),
  };
}

/* ----------------------------------------------------------- SkillStore --- */

export interface SkillWarning {
  path: string;
  reason: string;
}

export class SkillStore {
  private skills = new Map<string, Skill & { body: string }>();
  readonly warnings: SkillWarning[] = [];

  /** Roots already discovered from, remembered so rescan() can repeat them. */
  private discoveryRoots: Array<{ path: string; source: "builtin" | "user" }> = [];
  /** Absolute paths of roots whose entries the user may add/remove. */
  private userRoots = new Set<string>();

  private idSeq = 0;
  private newId(): string {
    this.idSeq++;
    return `skill_${this.idSeq}`;
  }

  /**
   * Walk each root for subdirectory/SKILL.md and register what is valid; skip
   * the rest. `source` tags every entry found under these roots ("user" for
   * installable userData roots, "builtin" for app-shipped/legacy roots).
   */
  async discover(roots: string[], source: "builtin" | "user" = "user"): Promise<void> {
    for (const root of roots) {
      // Remember the root even when unreadable so a later rescan retries it.
      if (!this.discoveryRoots.some((r) => r.path === root && r.source === source)) {
        this.discoveryRoots.push({ path: root, source });
      }
      let entries;
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillPath = join(root, entry.name, "SKILL.md");
        let text: string;
        try {
          const s = await stat(skillPath);
          if (!s.isFile()) continue;
          text = await readFile(skillPath, "utf-8");
        } catch {
          continue; // file doesn't exist
        }

        let meta: SkillFileMeta;
        try {
          meta = parseSkillFile(text, skillPath);
        } catch (e) {
          this.warnings.push({
            path: skillPath,
            reason: e instanceof Error ? e.message : String(e),
          });
          continue;
        }

        if (!meta.name) {
          this.warnings.push({ path: skillPath, reason: "Missing required field: name" });
          continue;
        }

        const id = this.newId();
        this.skills.set(meta.name, {
          id,
          name: meta.name,
          description: meta.description,
          ...(meta.whenToUse ? { whenToUse: meta.whenToUse } : {}),
          path: skillPath,
          source,
          enabled: true,
          modes: (meta.modes as Array<"cowork" | "code">) ?? ["cowork", "code"],
          ...(meta.allowedTools ? { allowedTools: meta.allowedTools } : {}),
          body: meta.body,
        });
      }
    }
  }

  /**
   * Register an installable user-skills root (userData/skills). Entries under
   * it may be removed via removeUserSkill; everything else is refused.
   */
  addUserRoot(root: string): void {
    this.userRoots.add(resolve(root));
  }

  /** True when a SKILL.md path lives inside a registered user root. */
  isUserManaged(skillPath: string): boolean {
    const resolved = resolve(skillPath);
    for (const root of this.userRoots) {
      if (resolved === root || resolved.startsWith(root + sepFor(root))) return true;
    }
    return false;
  }

  /**
   * Re-run discovery over all remembered roots. Enabled state is preserved by
   * skill name across rescans so adding one skill does not reset toggles.
   */
  async rescan(): Promise<void> {
    const enabledByName = new Map<string, boolean>();
    for (const skill of this.skills.values()) enabledByName.set(skill.name, skill.enabled);
    this.skills.clear();
    for (const { path, source } of this.discoveryRoots) {
      await this.discover([path], source);
    }
    for (const skill of this.skills.values()) {
      const wasEnabled = enabledByName.get(skill.name);
      if (wasEnabled !== undefined) skill.enabled = wasEnabled;
    }
  }

  /**
   * Delete a user-installed skill folder (the directory directly containing
   * its SKILL.md) and rescan. Refuses anything outside a registered user root.
   */
  async removeUserSkill(id: string): Promise<boolean> {
    const skill = [...this.skills.values()].find((s) => s.id === id);
    if (!skill || !this.isUserManaged(skill.path)) return false;
    const folder = dirname(resolve(skill.path));
    await rm(folder, { recursive: true, force: false });
    await this.rescan();
    return true;
  }

  register(skill: Skill & { body: string }): void {
    this.skills.set(skill.name, skill);
  }

  list(): Array<Skill & { body: string }> {
    return [...this.skills.values()];
  }

  get(name: string): (Skill & { body: string }) | undefined {
    return this.skills.get(name);
  }

  names(): string[] {
    return [...this.skills.keys()].sort();
  }

  /** Enable or disable a discovered skill by its stable renderer-facing id. */
  setEnabled(id: string, enabled: boolean): boolean {
    for (const skill of this.skills.values()) {
      if (skill.id !== id) continue;
      skill.enabled = enabled;
      return true;
    }
    return false;
  }
}

/** Path separator that keeps prefix checks correct on win32 and posix. */
function sepFor(root: string): string {
  return root.includes("\\") ? "\\" : "/";
}

/**
 * Install a skill source (a folder containing SKILL.md, or a single .md file)
 * into a user root and return the installed folder name. Exported for IPC.
 */
export async function installSkillSource(
  store: SkillStore,
  userRoot: string,
  sourcePath: string,
): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  const { mkdir, copyFile, cp, readdir } = await import("node:fs/promises");
  const resolved = resolve(sourcePath);
  let info;
  try {
    info = await stat(resolved);
  } catch {
    return { ok: false, error: `Source not found: ${resolved}` };
  }

  await mkdir(userRoot, { recursive: true });

  const lowerBase = basename(resolved).toLowerCase();
  if (info.isDirectory()) {
    const hasSkillMd = await readdir(resolved)
      .then((entries) => entries.some((e) => e.toLowerCase() === "skill.md"))
      .catch(() => false);
    if (!hasSkillMd) {
      return { ok: false, error: "The selected folder does not contain a SKILL.md file." };
    }
    const targetName = basename(resolved);
    const target = join(userRoot, targetName);
    await cp(resolved, target, { recursive: true });
  } else if (lowerBase.endsWith(".md")) {
    if (lowerBase === "skill.md") {
      // Treat the parent directory as the skill folder.
      const parent = dirname(resolved);
      const target = join(userRoot, basename(parent));
      await cp(parent, target, { recursive: true });
    } else {
      const slug = basename(resolved).replace(/\.md$/i, "").replace(/[^\w.-]+/g, "-") || "skill";
      const targetDir = join(userRoot, slug);
      await mkdir(targetDir, { recursive: true });
      await copyFile(resolved, join(targetDir, "SKILL.md"));
    }
  } else {
    return { ok: false, error: "Choose a folder containing SKILL.md or a .md file." };
  }

  await store.rescan();
  return { ok: true, name: basename(resolved) };
}

/* ---------------------------------------------------------- skill tools --- */

export function makeSkillTools(store: SkillStore): Tool[] {
  return [
    /* -------------------------------------------------------- skill_list */
    {
      definition: {
        name: "skill_list",
        title: "List Skills",
        description:
          "List all registered skills with their name, description, and when-to-use guidance.",
        inputSchema: {
          type: "object",
          properties: {},
        },
        icon: "sparkles",
        group: "skill",
        modes: ["cowork", "code"],
      },
      async handler(_input, _ctx) {
        const skills = store.list();
        if (skills.length === 0) {
          return ok("No skills registered.", { summary: "No skills" });
        }
        const lines = skills.map((s) => {
          const whenLine = s.whenToUse ? `\n  When to use: ${s.whenToUse}` : "";
          return `• ${s.name}\n  ${s.description}${whenLine}`;
        });
        return ok(lines.join("\n\n"), { summary: `${skills.length} skill(s)` });
      },
    },

    /* ------------------------------------------------------- skill_invoke */
    {
      definition: {
        name: "skill_invoke",
        title: "Invoke Skill",
        description:
          "Load a skill's instructions into context. The skill's SKILL.md body " +
          "is returned as the tool result so its guidance lands in your context. " +
          "Use skill_list to see available skill names.",
        inputSchema: {
          type: "object",
          properties: {
            skill: {
              type: "string",
              description: "The exact skill name as shown by skill_list.",
            },
            args: {
              type: "string",
              description: "Optional arguments or context to pass to the skill.",
            },
          },
          required: ["skill"],
        },
        icon: "sparkles",
        group: "skill",
        modes: ["cowork", "code"],
      },
      async handler(input, _ctx) {
        const name = String(input["skill"] ?? "").trim();
        const skillEntry = store.get(name);

        if (!skillEntry) {
          const available = store.names();
          return fail(
            available.length === 0
              ? `Skill "${name}" not found. No skills are registered.`
              : `Skill "${name}" not found. Available skills: ${available.join(", ")}.`,
          );
        }

        const body = skillEntry.body;
        return ok(
          body || `(Skill "${name}" has no body content.)`,
          { summary: `Invoked skill: ${name}` },
        );
      },
    },
  ];
}

export const defaultSkillStore = new SkillStore();
export const skillTools: Tool[] = makeSkillTools(defaultSkillStore);
