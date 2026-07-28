/**
 * Integration tests — MemoryVault, ProjectKnowledgeBase, and memory tools.
 *
 * Uses node:test + node:assert/strict.
 * Real file I/O against real temp directories; no mocks.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryVault } from "../../src/main/memory/vault.ts";
import { ProjectKnowledgeBase } from "../../src/main/memory/projectKb.ts";
import { makeMemoryTools } from "../../src/main/tools/memory.ts";
import { ToolRegistry } from "../../src/main/tools/registry.ts";
import type { ToolContext } from "../../src/main/tools/registry.ts";
import type { ModelCapabilities } from "../../src/shared/types.ts";

/* --------------------------------------------------------- test helpers --- */

const CAPS: ModelCapabilities = {
  vision: "yes",
  tools: true,
  streaming: true,
  reasoning: false,
};

function makeCtx(sessionId = "sess-1"): ToolContext {
  return {
    sessionId,
    mode: "cowork",
    workingFolder: null,
    outputsDir: tmpdir(),
    capabilities: CAPS,
    modelId: "test-model",
    providerId: "test",
    signal: new AbortController().signal,
    onProgress: () => undefined,
  };
}

/* ---------------------------------------------------------------- setup --- */

let vaultDir = "";
let projectRoot = "";

before(async () => {
  vaultDir = await mkdtemp(join(tmpdir(), "kozum-vault-"));
  projectRoot = await mkdtemp(join(tmpdir(), "kozum-proj-"));
});

after(async () => {
  if (vaultDir) await rm(vaultDir, { recursive: true, force: true });
  if (projectRoot) await rm(projectRoot, { recursive: true, force: true });
});

/* ======================================================= MemoryVault tests == */

describe("MemoryVault.init", () => {
  it("creates vault skeleton on first call", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vault-init-"));
    const vault = new MemoryVault(dir);
    await vault.init();

    // Check all required paths exist
    const check = async (p: string) => {
      const s = await stat(p);
      return s;
    };

    await assert.doesNotReject(() => check(join(dir, "_index.md")));
    await assert.doesNotReject(() => check(join(dir, "_hot-cache.md")));
    await assert.doesNotReject(() => check(join(dir, "user")));
    await assert.doesNotReject(() => check(join(dir, "feedback")));
    await assert.doesNotReject(() => check(join(dir, "projects")));
    await assert.doesNotReject(() => check(join(dir, "reference")));
    await assert.doesNotReject(() => check(join(dir, "knowledge")));
    await assert.doesNotReject(() => check(join(dir, "sessions")));

    await rm(dir, { recursive: true, force: true });
  });

  it("calling init twice is idempotent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vault-idempotent-"));
    const vault = new MemoryVault(dir);
    await vault.init();

    // Write a note and check it survives second init
    await vault.write({
      title: "Persistent Note",
      type: "user",
      description: "Should survive re-init",
      body: "Some content",
    });

    // Second init
    await vault.init();

    const notes = await vault.list();
    assert.ok(notes.some((n) => n.title === "Persistent Note"), "note should survive re-init");

    await rm(dir, { recursive: true, force: true });
  });
});

describe("MemoryVault.write and read", () => {
  let vault: MemoryVault;

  before(async () => {
    vault = new MemoryVault(vaultDir);
    await vault.init();
  });

  it("round-trips title, type, description, tags, and body", async () => {
    const note = await vault.write({
      title: "Test Round Trip",
      type: "reference",
      description: "A round-trip test note",
      tags: ["test", "roundtrip"],
      body: "This is the **body** of the note.",
    });

    assert.equal(note.title, "Test Round Trip");
    assert.equal(note.type, "reference");
    assert.equal(note.description, "A round-trip test note");
    assert.deepEqual(note.tags, ["test", "roundtrip"]);

    const read = await vault.read(note.id);
    assert.ok(read, "should be readable");
    assert.equal(read!.note.title, "Test Round Trip");
    assert.equal(read!.note.type, "reference");
    assert.equal(read!.note.description, "A round-trip test note");
    assert.deepEqual(read!.note.tags, ["test", "roundtrip"]);
    assert.ok(read!.body.includes("This is the **body**"), "body should be preserved");
  });

  it("slug collision produces a second distinct note without overwriting the first", async () => {
    const note1 = await vault.write({
      title: "Collision Test",
      type: "user",
      description: "First note",
      body: "Body of first note",
    });

    const note2 = await vault.write({
      title: "Collision Test",
      type: "user",
      description: "Second note",
      body: "Body of second note",
    });

    assert.notEqual(note1.id, note2.id, "ids must differ");

    // Verify first note is NOT overwritten
    const read1 = await vault.read(note1.id);
    assert.ok(read1, "first note should still exist");
    assert.equal(read1!.note.description, "First note", "first note description must be unchanged");
    assert.ok(read1!.body.includes("Body of first note"), "first note body must be unchanged");

    // Verify second note exists with its own content
    const read2 = await vault.read(note2.id);
    assert.ok(read2, "second note should exist");
    assert.equal(read2!.note.description, "Second note");
  });

  it("_index.md is updated on write", async () => {
    const note = await vault.write({
      title: "Index Update Test",
      type: "feedback",
      description: "Test that index gets updated",
      body: "Index update body",
    });

    const indexContent = await readFile(join(vaultDir, "_index.md"), "utf8");
    assert.ok(indexContent.includes(note.id), "_index.md should contain the note id");
    assert.ok(indexContent.includes("Index Update Test"), "_index.md should contain the title");
  });

  it("_index.md is updated on delete", async () => {
    const note = await vault.write({
      title: "To Be Deleted",
      type: "user",
      description: "This note will be deleted",
      body: "Temporary content",
    });

    const indexBefore = await readFile(join(vaultDir, "_index.md"), "utf8");
    assert.ok(indexBefore.includes(note.id), "note should be in index before delete");

    await vault.delete(note.id);

    const indexAfter = await readFile(join(vaultDir, "_index.md"), "utf8");
    assert.ok(!indexAfter.includes(note.id), "note id should be removed from index after delete");
  });
});

describe("MemoryVault.list", () => {
  let vault: MemoryVault;

  before(async () => {
    const dir = await mkdtemp(join(tmpdir(), "vault-list-"));
    vault = new MemoryVault(dir);
    await vault.init();

    await vault.write({ title: "User Note 1", type: "user", description: "u1", body: "u1" });
    await vault.write({ title: "User Note 2", type: "user", description: "u2", body: "u2" });
    await vault.write({ title: "Ref Note 1", type: "reference", description: "r1", body: "r1" });
    await vault.write({ title: "Feedback Note", type: "feedback", description: "f1", body: "f1" });
  });

  it("list() returns all notes", async () => {
    const all = await vault.list();
    assert.ok(all.length >= 4, `expected at least 4 notes, got ${all.length}`);
  });

  it("list('user') returns only user notes", async () => {
    const userNotes = await vault.list("user");
    assert.ok(userNotes.length >= 2, "should have at least 2 user notes");
    for (const n of userNotes) {
      assert.equal(n.type, "user", `all returned notes must be type "user"`);
    }
  });

  it("list('reference') returns only reference notes", async () => {
    const refNotes = await vault.list("reference");
    assert.ok(refNotes.length >= 1);
    for (const n of refNotes) {
      assert.equal(n.type, "reference");
    }
  });
});

describe("MemoryVault.search", () => {
  let vault: MemoryVault;

  before(async () => {
    const dir = await mkdtemp(join(tmpdir(), "vault-search-"));
    vault = new MemoryVault(dir);
    await vault.init();

    // Title match note
    await vault.write({
      title: "Chocolate Chip Cookies",
      type: "reference",
      description: "Recipe for cookies",
      tags: ["food", "baking"],
      body: "Mix flour, butter, and sugar.",
    });

    // Body-only match note
    await vault.write({
      title: "Random Document",
      type: "user",
      description: "Something else entirely",
      tags: ["misc"],
      body: "This document mentions chocolate somewhere in the text but not in the title.",
    });

    // Completely unrelated
    await vault.write({
      title: "Unrelated Topic",
      type: "feedback",
      description: "Nothing about baking",
      tags: [],
      body: "This is about something totally different.",
    });
  });

  it("title match ranks above body-only match", async () => {
    const results = await vault.search("chocolate");
    assert.ok(results.length >= 2, "should find at least 2 results");
    const topId = results[0]!.id;
    const topNote = await vault.read(topId);
    assert.ok(
      topNote?.note.title.toLowerCase().includes("chocolate"),
      `top result should be the title-match note, got: ${topNote?.note.title}`,
    );
  });

  it("stopwords do not dominate results", async () => {
    // "the" is a stopword and should be ignored
    const results1 = await vault.search("chocolate the cookies");
    const results2 = await vault.search("chocolate cookies");
    // The stopword must not change the outcome. Comparing the two rankings is
    // the actual assertion; merely checking results1 is non-empty would pass
    // even if "the" dominated the score.
    assert.ok(results1.length > 0, "should return results despite stopword");
    assert.deepEqual(
      results1.map((r) => r.id),
      results2.map((r) => r.id),
      "a stopword must not alter the ranking",
    );
    // The top result should still be the cookie note
    if (results1.length > 0) {
      const top = await vault.read(results1[0]!.id);
      assert.ok(top?.note.title.toLowerCase().includes("chocolate") || top?.note.title.toLowerCase().includes("cookie"));
    }
  });
});

describe("MemoryVault.resolveLinks and backlinks", () => {
  let vault: MemoryVault;
  let noteAId: string;
  let noteBId: string;

  before(async () => {
    const dir = await mkdtemp(join(tmpdir(), "vault-links-"));
    vault = new MemoryVault(dir);
    await vault.init();

    const noteB = await vault.write({
      title: "Note Beta",
      type: "reference",
      description: "Target note",
      body: "I am the target.",
    });
    noteBId = noteB.id;

    const noteA = await vault.write({
      title: "Note Alpha",
      type: "user",
      description: "Source note",
      body: `I link to [[${noteBId}]] and also [[nonexistent-note]].`,
    });
    noteAId = noteA.id;
  });

  it("resolveLinks returns resolved ids and unresolved targets", async () => {
    const { resolved, unresolved } = await vault.resolveLinks(noteAId);
    assert.ok(resolved.includes(noteBId), `resolved should include ${noteBId}`);
    assert.ok(unresolved.includes("nonexistent-note"), "unresolved should include the dead link");
  });

  it("backlinks are correct in both directions", async () => {
    // noteA links to noteB, so noteB should have noteA as a backlink
    const bBacklinks = await vault.backlinks(noteBId);
    assert.ok(bBacklinks.includes(noteAId), `${noteBId} should have ${noteAId} as a backlink`);

    // noteA has no inbound links in this test
    const aBacklinks = await vault.backlinks(noteAId);
    assert.ok(!aBacklinks.includes(noteBId), "noteB should not link back to noteA");
  });
});

describe("MemoryVault.appendHotCache", () => {
  let vault: MemoryVault;
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "vault-hotcache-"));
    vault = new MemoryVault(dir, 3); // trim to 3 entries
    await vault.init();
  });

  it("prepends summary to hot-cache", async () => {
    await vault.appendHotCache("First session summary");
    const content = await readFile(join(dir, "_hot-cache.md"), "utf8");
    assert.ok(content.includes("First session summary"), "should contain the summary");
  });

  it("trims to the configured limit", async () => {
    await vault.appendHotCache("Second session");
    await vault.appendHotCache("Third session");
    await vault.appendHotCache("Fourth session — should push first off");

    const content = await readFile(join(dir, "_hot-cache.md"), "utf8");
    // Most recent should be present
    assert.ok(content.includes("Fourth session"), "most recent session should be present");
    // First session should be gone (limit is 3)
    assert.ok(!content.includes("First session summary"), "oldest session should be trimmed");
  });
});

describe("MemoryVault.loadStartupContext", () => {
  let vault: MemoryVault;

  before(async () => {
    const dir = await mkdtemp(join(tmpdir(), "vault-startup-"));
    vault = new MemoryVault(dir);
    await vault.init();
    await vault.write({ title: "Startup Test", type: "user", description: "for startup ctx", body: "body" });
    await vault.appendHotCache("Recent session summary");
  });

  it("contains both index and hot-cache content", async () => {
    const ctx = await vault.loadStartupContext();
    // Index content
    assert.ok(ctx.includes("Memory Vault Index") || ctx.includes("index"), "should include index");
    // Hot cache content
    assert.ok(ctx.includes("Recent Sessions") || ctx.includes("Recent session summary"), "should include hot cache");
  });
});

describe("MemoryVault.lint", () => {
  let vault: MemoryVault;

  before(async () => {
    const dir = await mkdtemp(join(tmpdir(), "vault-lint-"));
    vault = new MemoryVault(dir);
    await vault.init();

    // Orphan: not linked to by anyone
    await vault.write({
      title: "Lonely Orphan",
      type: "user",
      description: "No one links to me",
      body: "I am isolated",
    });

    // Dead link: links to nonexistent note
    await vault.write({
      title: "Dead Linker",
      type: "user",
      description: "Links to nothing",
      body: "I point to [[totally-fake-note-that-does-not-exist]]",
    });

    // Missing description
    await vault.write({
      title: "No Description Note",
      type: "reference",
      description: "",
      body: "This note has no description",
    });
  });

  it("detects orphan notes", async () => {
    const report = await vault.lint();
    assert.ok(report.orphans.length > 0, "should detect at least one orphan");
  });

  it("detects dead links", async () => {
    const report = await vault.lint();
    assert.ok(report.deadLinks.length > 0, "should detect at least one dead link");
    const deadTargets = report.deadLinks.map((d) => d.target);
    assert.ok(
      deadTargets.some((t) => t.includes("totally-fake")),
      "dead link target should match the nonexistent note",
    );
  });

  it("detects notes missing a description", async () => {
    const report = await vault.lint();
    assert.ok(report.missingDescription.length > 0, "should detect notes with no description");
  });
});

/* =================================================== Obsidian compatibility == */

describe("Obsidian compatibility", () => {
  it("written note raw text starts with ---, contains type:, and links render as [[...]]", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vault-obsidian-"));
    const vault = new MemoryVault(dir);
    await vault.init();

    const note = await vault.write({
      title: "Obsidian Test Note",
      type: "project",
      description: "For Obsidian compatibility check",
      body: "This note links to [[some-other-note]] for Obsidian.",
    });

    const raw = await readFile(note.path, "utf8");

    assert.ok(raw.startsWith("---"), "raw file must start with ---");
    assert.ok(raw.includes("type:"), "frontmatter must contain type:");
    assert.ok(raw.includes("[[some-other-note]]"), "body must contain [[wikilink]] syntax");

    await rm(dir, { recursive: true, force: true });
  });
});

/* ================================================== ProjectKnowledgeBase === */

describe("ProjectKnowledgeBase.build", () => {
  let kb: ProjectKnowledgeBase;
  let tempKbRoot: string;
  let tempProjRoot: string;

  before(async () => {
    tempKbRoot = await mkdtemp(join(tmpdir(), "kb-vault-"));
    tempProjRoot = await mkdtemp(join(tmpdir(), "kb-proj-"));

    // Create a small project tree
    await mkdir(join(tempProjRoot, "src"), { recursive: true });
    await writeFile(join(tempProjRoot, "package.json"), JSON.stringify({ name: "test-project" }));
    await writeFile(join(tempProjRoot, "src", "index.ts"), "export const x = 1;");
    await writeFile(join(tempProjRoot, "src", "utils.ts"), "export const y = 2;");
    await writeFile(join(tempProjRoot, "README.md"), "# Test Project");

    kb = new ProjectKnowledgeBase(tempKbRoot, "test-proj");
    await kb.build(tempProjRoot);
  });

  after(async () => {
    await rm(tempKbRoot, { recursive: true, force: true });
    await rm(tempProjRoot, { recursive: true, force: true });
  });

  it("file map lists the files", async () => {
    const fileMapPath = join(tempKbRoot, "project-kb", "test-proj", "file-map.md");
    const content = await readFile(fileMapPath, "utf8");
    assert.ok(content.includes("index.ts"), "file map should list index.ts");
    assert.ok(content.includes("utils.ts"), "file map should list utils.ts");
    assert.ok(content.includes("README.md"), "file map should list README.md");
  });

  it("stack detected from package.json", async () => {
    const archPath = join(tempKbRoot, "project-kb", "test-proj", "architecture.md");
    const content = await readFile(archPath, "utf8");
    assert.ok(
      content.includes("Node.js") || content.includes("npm") || content.includes("package.json"),
      "architecture should detect Node.js/npm from package.json",
    );
  });
});

describe("ProjectKnowledgeBase.updateIncremental", () => {
  it("reports exactly 1 added, 1 modified, 1 removed", async () => {
    const kbRoot = await mkdtemp(join(tmpdir(), "kb-inc-vault-"));
    const projRoot = await mkdtemp(join(tmpdir(), "kb-inc-proj-"));

    // Initial state: 3 files
    await mkdir(join(projRoot, "src"), { recursive: true });
    await writeFile(join(projRoot, "src", "alpha.ts"), "const a = 1;");
    await writeFile(join(projRoot, "src", "beta.ts"), "const b = 2;");
    await writeFile(join(projRoot, "src", "gamma.ts"), "const c = 3;");

    const kb = new ProjectKnowledgeBase(kbRoot, "inc-proj");
    await kb.build(projRoot);

    // Wait a tiny bit to ensure different mtime
    await new Promise((r) => setTimeout(r, 50));

    // Modify beta.ts by rewriting with different content (different size ensures mtime check)
    const betaPath = join(projRoot, "src", "beta.ts");
    await writeFile(betaPath, "const b = 2; // modified with extra content to change size");

    // Force a different mtime on the modified file
    const futureTime = new Date(Date.now() + 2000);
    await utimes(betaPath, futureTime, futureTime);

    // Remove gamma.ts
    const { unlink } = await import("node:fs/promises");
    await unlink(join(projRoot, "src", "gamma.ts"));

    // Add delta.ts
    await writeFile(join(projRoot, "src", "delta.ts"), "const d = 4;");

    const result = await kb.updateIncremental(projRoot);

    assert.equal(result.added, 1, `expected 1 added, got ${result.added}`);
    assert.equal(result.modified, 1, `expected 1 modified, got ${result.modified}`);
    assert.equal(result.removed, 1, `expected 1 removed, got ${result.removed}`);

    await rm(kbRoot, { recursive: true, force: true });
    await rm(projRoot, { recursive: true, force: true });
  });
});

/* ======================================================== memory tools === */

describe("memory tools via ToolRegistry", () => {
  let registry: ToolRegistry;
  let vault: MemoryVault;

  before(async () => {
    const dir = await mkdtemp(join(tmpdir(), "vault-tools-"));
    vault = new MemoryVault(dir);
    await vault.init();

    const kbFactory = (projectId: string) =>
      new ProjectKnowledgeBase(dir, projectId);

    registry = new ToolRegistry();
    registry.registerAll(makeMemoryTools(vault, kbFactory));
  });

  it("all 7 tools are registered", () => {
    const names = registry.names();
    const expected = [
      "memory_delete",
      "memory_list",
      "memory_read",
      "memory_search",
      "memory_write",
      "project_kb_build",
      "project_kb_update",
    ];
    for (const name of expected) {
      assert.ok(names.includes(name), `${name} should be registered`);
    }
  });

  it("memory_write → memory_read round trip via registry", async () => {
    const ctx = makeCtx("tools-1");
    const writeResult = await registry.execute(
      "memory_write",
      {
        title: "Via Registry",
        type: "user",
        description: "Created through the tool registry",
        body: "Some body content here",
        tags: ["tools", "test"],
      },
      ctx,
    );
    assert.ok(writeResult.ok, `write failed: ${writeResult.error}`);
    const idMatch = writeResult.content.match(/id=([^\n]+)/);
    assert.ok(idMatch, "result should contain id=...");
    const noteId = idMatch![1]!.trim();

    const readResult = await registry.execute("memory_read", { id: noteId }, ctx);
    assert.ok(readResult.ok, `read failed: ${readResult.error}`);
    assert.ok(readResult.content.includes("Via Registry"), "body should contain title");
    assert.ok(readResult.content.includes("Some body content here"), "body should contain content");
  });

  it("memory_search returns results in correct mode", async () => {
    const ctx = makeCtx("tools-2");
    await registry.execute(
      "memory_write",
      {
        title: "Quantum Physics Overview",
        type: "reference",
        description: "Overview of quantum mechanics",
        body: "Quantum entanglement and superposition are fundamental concepts.",
        tags: ["physics", "quantum"],
      },
      ctx,
    );

    const searchResult = await registry.execute(
      "memory_search",
      { query: "quantum physics", limit: 5 },
      ctx,
    );
    assert.ok(searchResult.ok, `search failed: ${searchResult.error}`);
    assert.ok(
      searchResult.content.includes("Quantum") || searchResult.content.includes("quantum"),
      "search results should mention the note",
    );
  });

  it("memory_list with type filter", async () => {
    const ctx = makeCtx("tools-3");
    await registry.execute(
      "memory_write",
      { title: "List Test User", type: "user", description: "user type note", body: "body" },
      ctx,
    );
    await registry.execute(
      "memory_write",
      { title: "List Test Feedback", type: "feedback", description: "feedback type note", body: "body" },
      ctx,
    );

    const listResult = await registry.execute("memory_list", { type: "user" }, ctx);
    assert.ok(listResult.ok, `list failed: ${listResult.error}`);
    assert.ok(listResult.content.includes("List Test User"), "should show user note");
  });

  it("memory_delete removes a note", async () => {
    const ctx = makeCtx("tools-4");
    const writeResult = await registry.execute(
      "memory_write",
      { title: "Delete Me", type: "user", description: "to be deleted", body: "bye" },
      ctx,
    );
    assert.ok(writeResult.ok);
    const idMatch = writeResult.content.match(/id=([^\n]+)/);
    assert.ok(idMatch);
    const noteId = idMatch![1]!.trim();

    const deleteResult = await registry.execute("memory_delete", { id: noteId }, ctx);
    assert.ok(deleteResult.ok, `delete failed: ${deleteResult.error}`);

    const readResult = await registry.execute("memory_read", { id: noteId }, ctx);
    assert.ok(!readResult.ok, "read after delete should fail");
  });

  it("tools are available in both cowork and code modes", () => {
    const coworkTools = registry.list("cowork");
    const codeTools = registry.list("code");
    const toolNames = ["memory_write", "memory_read", "memory_search", "memory_list", "memory_delete", "project_kb_build", "project_kb_update"];
    for (const name of toolNames) {
      assert.ok(coworkTools.some((t) => t.name === name), `${name} missing from cowork`);
      assert.ok(codeTools.some((t) => t.name === name), `${name} missing from code`);
    }
  });

  it("project_kb_build works via registry", async () => {
    const projDir = await mkdtemp(join(tmpdir(), "kb-tool-proj-"));
    await writeFile(join(projDir, "package.json"), JSON.stringify({ name: "tool-test" }));
    await writeFile(join(projDir, "index.ts"), "const x = 1;");

    const ctx = makeCtx("tools-5");
    const buildResult = await registry.execute(
      "project_kb_build",
      { path: projDir, project_id: "tool-test-proj" },
      ctx,
    );
    assert.ok(buildResult.ok, `kb_build failed: ${buildResult.error}`);
    assert.ok(
      buildResult.content.includes("tool-test-proj"),
      "result should mention the project id",
    );

    await rm(projDir, { recursive: true, force: true });
  });
});
