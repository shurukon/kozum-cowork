/**
 * Integration tests for MemoryVault rules (RULES.md).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryVault } from "../../src/main/memory/vault.ts";

let tmpDir: string;
let vault: MemoryVault;

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "kozum-rules-"));
  vault = new MemoryVault(tmpDir);
  await vault.init();
});

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("MemoryVault.getRules / setRules", () => {
  it("returns empty string when RULES.md does not exist", async () => {
    const rules = await vault.getRules();
    assert.equal(rules, "", "rules should be empty initially");
  });

  it("setRules persists text and getRules retrieves it", async () => {
    await vault.setRules("Always be concise.\nNever use passive voice.");
    const rules = await vault.getRules();
    assert.ok(rules.includes("Always be concise."), `expected rules content, got: ${rules}`);
    assert.ok(rules.includes("Never use passive voice."));
  });

  it("setRules overwrites previous rules", async () => {
    await vault.setRules("Old rule.");
    await vault.setRules("New rule only.");
    const rules = await vault.getRules();
    assert.ok(rules.includes("New rule only."), "new rules should be present");
    assert.ok(!rules.includes("Old rule."), "old rules should be replaced");
  });

  it("setRules with empty string clears the rules file", async () => {
    await vault.setRules("Something.");
    await vault.setRules("");
    const rules = await vault.getRules();
    assert.equal(rules, "", "rules should be empty after clearing");
  });

  it("rulesPath is inside the vault root", () => {
    assert.ok(
      vault.rulesPath.startsWith(tmpDir),
      `rulesPath ${vault.rulesPath} should be inside ${tmpDir}`,
    );
    assert.ok(vault.rulesPath.endsWith("RULES.md"), "rulesPath should end with RULES.md");
  });
});
