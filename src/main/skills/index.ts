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

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

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

  private idSeq = 0;
  private newId(): string {
    this.idSeq++;
    return `skill_${this.idSeq}`;
  }

  /** Walk each root for subdirectory/SKILL.md and register what is valid; skip the rest. */
  async discover(roots: string[]): Promise<void> {
    for (const root of roots) {
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
          source: "user",
          enabled: true,
          modes: (meta.modes as Array<"cowork" | "code">) ?? ["cowork", "code"],
          ...(meta.allowedTools ? { allowedTools: meta.allowedTools } : {}),
          body: meta.body,
        });
      }
    }
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
