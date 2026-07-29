/**
 * Integration tests for the bundled/ directory.
 *
 * Verifies that every bundled skill and plugin file:
 * - Parses with the REAL parsers (not a reimplementation).
 * - Has a non-empty name and description.
 * - Every subagent has a non-trivial system prompt body.
 * - No content contains forged context-injection tags.
 *
 * Uses node:test + node:assert/strict.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { parseSkillFile } from "../../src/main/skills/index.ts";
import { parseSubagentFile } from "../../src/main/agent/subagents.ts";
import { parsePluginManifest } from "../../src/main/plugins/manifest.ts";
import { discoverContributions } from "../../src/main/plugins/discover.ts";

/* ----------------------------------------------------------------- paths */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..", "..");
const bundledSkillsDir = join(repoRoot, "bundled", "skills");
const bundledPluginsDir = join(repoRoot, "bundled", "plugins");

/* ---------------------------------------- helpers */

async function listDirectories(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

/** Forbidden strings that must not appear in skill or subagent bodies. */
const FORBIDDEN_TAGS = ["</memory>", "<user_instructions>", "<system>", "</system_prompt>"];

function assertNoForgeryTags(text: string, path: string): void {
  for (const tag of FORBIDDEN_TAGS) {
    assert.ok(
      !text.includes(tag),
      `${path}: body contains forged context-injection tag "${tag}"`,
    );
  }
}

/* ================================================================ bundled/skills */

describe("bundled/skills — parseSkillFile", () => {
  it("all skill directories exist and have a SKILL.md", async () => {
    const dirs = await listDirectories(bundledSkillsDir);
    assert.ok(dirs.length > 0, "bundled/skills/ must contain at least one subdirectory");

    for (const dir of dirs) {
      const skillPath = join(bundledSkillsDir, dir, "SKILL.md");
      let s;
      try {
        s = await stat(skillPath);
      } catch {
        assert.fail(`Expected ${skillPath} to exist`);
      }
      assert.ok(s!.isFile(), `${skillPath} must be a file`);
    }
  });

  it("each SKILL.md parses with the real parseSkillFile — non-empty name and description", async () => {
    const dirs = await listDirectories(bundledSkillsDir);
    assert.ok(dirs.length >= 4, "Expected at least 4 standalone skills");

    for (const dir of dirs) {
      const skillPath = join(bundledSkillsDir, dir, "SKILL.md");
      let text: string;
      try {
        text = await readFile(skillPath, "utf-8");
      } catch {
        assert.fail(`Could not read ${skillPath}`);
        return;
      }

      // Uses the REAL parser — not a reimplementation
      let meta;
      try {
        meta = parseSkillFile(text, skillPath);
      } catch (e) {
        assert.fail(`parseSkillFile threw on ${skillPath}: ${e}`);
        return;
      }

      assert.ok(meta.name.length > 0, `${skillPath}: name must be non-empty`);
      assert.ok(meta.description.length > 0, `${skillPath}: description must be non-empty`);
      assert.ok(meta.body.length > 100, `${skillPath}: body must have substantial content (> 100 chars), got ${meta.body.length}`);
    }
  });

  it("no skill body contains forged context-injection tags", async () => {
    const dirs = await listDirectories(bundledSkillsDir);
    for (const dir of dirs) {
      const skillPath = join(bundledSkillsDir, dir, "SKILL.md");
      let text: string;
      try {
        text = await readFile(skillPath, "utf-8");
      } catch {
        continue;
      }
      const meta = parseSkillFile(text, skillPath);
      assertNoForgeryTags(meta.body, skillPath);
    }
  });
});

/* ================================================================ bundled/plugins — plugin.json */

describe("bundled/plugins — parsePluginManifest", () => {
  it("all plugin directories have a valid .claude-plugin/plugin.json", async () => {
    const dirs = await listDirectories(bundledPluginsDir);
    assert.ok(dirs.length > 0, "bundled/plugins/ must contain at least one plugin");

    for (const dir of dirs) {
      const manifestPath = join(bundledPluginsDir, dir, ".claude-plugin", "plugin.json");
      let text: string;
      try {
        text = await readFile(manifestPath, "utf-8");
      } catch {
        assert.fail(`Expected ${manifestPath} to exist and be readable`);
        return;
      }

      // Uses the REAL parser
      const result = parsePluginManifest(text, manifestPath);
      assert.ok(result.ok, `parsePluginManifest failed for ${manifestPath}: ${!result.ok ? result.error : ""}`);
      if (!result.ok) return;

      assert.ok(result.value.name.length > 0, `${manifestPath}: name must be non-empty`);
      assert.ok(result.value.description.length > 0, `${manifestPath}: description must be non-empty`);
      assert.ok(result.value.version.length > 0, `${manifestPath}: version must be non-empty`);
    }
  });
});

/* ================================================================ kozum-engineering plugin — discoverContributions */

describe("bundled/plugins/kozum-engineering — discoverContributions", () => {
  it("finds exactly 3 skills and 5 agents", async () => {
    const pluginDir = join(bundledPluginsDir, "kozum-engineering");
    const result = await discoverContributions(pluginDir);

    assert.equal(
      result.skills.length,
      3,
      `Expected 3 skills, got ${result.skills.length}. Warnings: ${JSON.stringify(result.warnings)}`,
    );
    assert.equal(
      result.agents.length,
      5,
      `Expected 5 agents, got ${result.agents.length}. Warnings: ${JSON.stringify(result.warnings)}`,
    );

    // No warnings — all files should be valid
    assert.equal(
      result.warnings.length,
      0,
      `Expected no warnings, got: ${JSON.stringify(result.warnings)}`,
    );
  });

  it("skill names are non-empty and descriptions are non-empty", async () => {
    const pluginDir = join(bundledPluginsDir, "kozum-engineering");
    const result = await discoverContributions(pluginDir);

    for (const skill of result.skills) {
      assert.ok(skill.name.length > 0, `Skill name must be non-empty`);
      assert.ok(skill.description.length > 0, `Skill "${skill.name}" must have a non-empty description`);
    }
  });

  it("agent names and descriptions are non-empty", async () => {
    const pluginDir = join(bundledPluginsDir, "kozum-engineering");
    const result = await discoverContributions(pluginDir);

    for (const agent of result.agents) {
      assert.ok(agent.name.length > 0, `Agent name must be non-empty`);
      assert.ok(agent.description.length > 0, `Agent "${agent.name}" must have a non-empty description`);
    }
  });
});

/* ================================================================ agents — parseSubagentFile */

describe("bundled/plugins/kozum-engineering/agents — parseSubagentFile", () => {
  it("all agent files parse with the real parseSubagentFile", async () => {
    const agentsDir = join(bundledPluginsDir, "kozum-engineering", "agents");
    const entries = await readdir(agentsDir, { withFileTypes: true });
    const agentFiles = entries.filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name);

    assert.equal(agentFiles.length, 5, `Expected 5 agent files, got ${agentFiles.length}`);

    for (const filename of agentFiles) {
      const agentPath = join(agentsDir, filename);
      const text = await readFile(agentPath, "utf-8");

      // Uses the REAL parser
      let meta;
      try {
        meta = parseSubagentFile(text, agentPath);
      } catch (e) {
        assert.fail(`parseSubagentFile threw on ${agentPath}: ${e}`);
        return;
      }

      assert.ok(meta.name.length > 0, `${agentPath}: name must be non-empty`);
      assert.ok(meta.description.length > 0, `${agentPath}: description must be non-empty`);

      // Non-trivial system prompt: at least 500 chars
      assert.ok(
        meta.systemPrompt.length >= 500,
        `${agentPath}: systemPrompt must be at least 500 chars (got ${meta.systemPrompt.length}) — a stub cannot pass`,
      );
    }
  });

  it("no agent body contains forged context-injection tags", async () => {
    const agentsDir = join(bundledPluginsDir, "kozum-engineering", "agents");
    const entries = await readdir(agentsDir, { withFileTypes: true });
    const agentFiles = entries.filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name);

    for (const filename of agentFiles) {
      const agentPath = join(agentsDir, filename);
      const text = await readFile(agentPath, "utf-8");
      const meta = parseSubagentFile(text, agentPath);
      assertNoForgeryTags(meta.systemPrompt, agentPath);
    }
  });
});

/* ================================================================ cross-check: expected skill names */

describe("bundled/skills — expected named skills present", () => {
  it("contains the four expected standalone skills", async () => {
    const dirs = await listDirectories(bundledSkillsDir);
    const expectedDirs = ["open-design", "ui-ux-pro-max", "app-testing", "document-craft"];

    for (const expected of expectedDirs) {
      assert.ok(
        dirs.includes(expected),
        `Expected bundled/skills/${expected}/ to exist. Found: ${dirs.join(", ")}`,
      );
    }
  });

  it("each skill parses with a recognisable name (not empty, not just whitespace)", async () => {
    const dirs = await listDirectories(bundledSkillsDir);
    for (const dir of dirs) {
      const skillPath = join(bundledSkillsDir, dir, "SKILL.md");
      let text: string;
      try {
        text = await readFile(skillPath, "utf-8");
      } catch {
        continue;
      }
      const meta = parseSkillFile(text, skillPath);
      assert.ok(meta.name.trim().length > 0, `${skillPath}: name must not be blank`);
    }
  });
});

/* ================================================================ plugin skills — expected names */

describe("bundled/plugins/kozum-engineering/skills — expected named skills present", () => {
  it("contains code-review, debugging, refactoring", async () => {
    const skillsDir = join(bundledPluginsDir, "kozum-engineering", "skills");
    const dirs = await listDirectories(skillsDir);
    const expected = ["code-review", "debugging", "refactoring"];

    for (const name of expected) {
      assert.ok(
        dirs.includes(name),
        `Expected skills/${name}/ to exist in the kozum-engineering plugin. Found: ${dirs.join(", ")}`,
      );
    }
  });
});
