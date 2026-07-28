/**
 * Integration tests for fs/dir/env tools.
 *
 * Uses a real temp directory; no mocks. Cleans up after itself.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";

import { ToolRegistry } from "../../src/main/tools/registry.ts";
import { fsTools } from "../../src/main/tools/fs.ts";
import { dirTools } from "../../src/main/tools/dir.ts";
import { envTools } from "../../src/main/tools/env.ts";
import type { ToolContext } from "../../src/main/tools/registry.ts";

/* ---------------------------------------------------------------- setup */

let tmpDir: string;

const registry = new ToolRegistry();

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "kozum-fs-"));
  registry.registerAll(fsTools);
  registry.registerAll(dirTools);
  registry.registerAll(envTools);
});

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: "test",
    mode: "code",
    workingFolder: tmpDir,
    outputsDir: tmpDir,
    capabilities: { vision: "yes", tools: true, streaming: true, reasoning: false },
    modelId: "test-model",
    providerId: "test-provider",
    signal: new AbortController().signal,
    onProgress: () => {},
    ...overrides,
  };
}

/* -------------------------------------------------------------- file_write / file_read round-trip */

describe("file_write + file_read", () => {
  it("writes and reads back content", async () => {
    const ctx = makeCtx();
    const wResult = await registry.execute(
      "file_write",
      { path: "hello.txt", content: "line1\nline2\nline3" },
      ctx,
    );
    assert.equal(wResult.ok, true);

    const rResult = await registry.execute("file_read", { path: "hello.txt" }, ctx);
    assert.equal(rResult.ok, true);
    assert.ok(rResult.content.includes("line1"));
    assert.ok(rResult.content.includes("line3"));
  });

  it("append mode adds to existing file", async () => {
    const ctx = makeCtx();
    await registry.execute("file_write", { path: "append.txt", content: "first\n" }, ctx);
    await registry.execute(
      "file_write",
      { path: "append.txt", content: "second\n", append: true },
      ctx,
    );
    const r = await registry.execute("file_read", { path: "append.txt" }, ctx);
    assert.ok(r.content.includes("first"));
    assert.ok(r.content.includes("second"));
  });
});

/* --------------------------------------------------------------- offset / limit */

describe("file_read offset and limit", () => {
  it("reads with positive offset and limit", async () => {
    const ctx = makeCtx();
    await registry.execute(
      "file_write",
      { path: "lines.txt", content: "LINEONE\nLINETWO\nLINETHREE\nLINEFOUR\nLINEFIVE" },
      ctx,
    );
    const r = await registry.execute(
      "file_read",
      { path: "lines.txt", offset: 1, limit: 2 },
      ctx,
    );
    assert.equal(r.ok, true);
    // offset:1 skips LINEONE, limit:2 returns LINETWO and LINETHREE
    assert.ok(r.content.includes("LINETWO"));
    assert.ok(r.content.includes("LINETHREE"));
    assert.ok(!r.content.includes("LINEONE"));
  });

  it("negative offset counts from end", async () => {
    const ctx = makeCtx();
    await registry.execute(
      "file_write",
      { path: "neg.txt", content: "x\ny\nz" },
      ctx,
    );
    const r = await registry.execute(
      "file_read",
      { path: "neg.txt", offset: -1 },
      ctx,
    );
    assert.equal(r.ok, true);
    assert.ok(r.content.includes("z"));
    assert.ok(!r.content.includes("x"));
  });
});

/* ---------------------------------------------------------------- file_edit */

describe("file_edit", () => {
  it("replaces first (unique) occurrence", async () => {
    const ctx = makeCtx();
    // "unique_token" appears exactly once, so single-replace succeeds
    await registry.execute("file_write", { path: "edit.txt", content: "hello unique_token world" }, ctx);
    const r = await registry.execute(
      "file_edit",
      { path: "edit.txt", oldString: "unique_token", newString: "REPLACED" },
      ctx,
    );
    assert.equal(r.ok, true);
    const content = await registry.execute("file_read", { path: "edit.txt" }, ctx);
    assert.ok(content.content.includes("REPLACED"));
    assert.ok(!content.content.includes("unique_token"));
  });

  it("fails with clear message when oldString not found", async () => {
    const ctx = makeCtx();
    await registry.execute("file_write", { path: "notfound.txt", content: "hello world" }, ctx);
    const r = await registry.execute(
      "file_edit",
      { path: "notfound.txt", oldString: "MISSING_STRING", newString: "x" },
      ctx,
    );
    assert.equal(r.ok, false);
    assert.ok(r.error?.includes("not found") || r.error?.includes("MISSING_STRING"));
  });

  it("fails when oldString appears multiple times without replaceAll", async () => {
    const ctx = makeCtx();
    await registry.execute(
      "file_write",
      { path: "multi.txt", content: "foo foo foo" },
      ctx,
    );
    const r = await registry.execute(
      "file_edit",
      { path: "multi.txt", oldString: "foo", newString: "bar" },
      ctx,
    );
    assert.equal(r.ok, false);
    // Should mention the count or disambiguation
    assert.ok(r.error?.includes("3") || r.error?.includes("multiple") || r.error?.includes("times"));
  });

  it("replaceAll=true replaces all occurrences", async () => {
    const ctx = makeCtx();
    await registry.execute("file_write", { path: "replaceall.txt", content: "a a a" }, ctx);
    const r = await registry.execute(
      "file_edit",
      { path: "replaceall.txt", oldString: "a", newString: "b", replaceAll: true },
      ctx,
    );
    assert.equal(r.ok, true);
    const content = await registry.execute("file_read", { path: "replaceall.txt" }, ctx);
    assert.ok(!content.content.includes("a"));
    assert.ok(content.content.includes("b"));
  });
});

/* -------------------------------------------------------- file_edit_enhanced dryRun */

describe("file_edit_enhanced", () => {
  it("dryRun reports count without modifying", async () => {
    const ctx = makeCtx();
    await registry.execute("file_write", { path: "dry.txt", content: "x x x" }, ctx);
    const r = await registry.execute(
      "file_edit_enhanced",
      { path: "dry.txt", oldString: "x", newString: "y", replaceAll: true, dryRun: true },
      ctx,
    );
    assert.equal(r.ok, true);
    assert.ok(r.content.includes("3") || r.content.includes("DRY"));
    // File must be unchanged
    const c = await registry.execute("file_read", { path: "dry.txt" }, ctx);
    assert.ok(c.content.includes("x"));
  });

  it("actually applies edit when dryRun=false", async () => {
    const ctx = makeCtx();
    await registry.execute("file_write", { path: "apply.txt", content: "hello hello" }, ctx);
    const r = await registry.execute(
      "file_edit_enhanced",
      { path: "apply.txt", oldString: "hello", newString: "world", replaceAll: true, dryRun: false },
      ctx,
    );
    assert.equal(r.ok, true);
    const c = await registry.execute("file_read", { path: "apply.txt" }, ctx);
    assert.ok(!c.content.includes("hello"));
    assert.ok(c.content.includes("world"));
  });
});

/* ---------------------------------------------------------------- file_move */

describe("file_move", () => {
  it("moves a file to a new location", async () => {
    const ctx = makeCtx();
    await registry.execute("file_write", { path: "mv-src.txt", content: "moved" }, ctx);
    const r = await registry.execute(
      "file_move",
      { source: "mv-src.txt", destination: "subdir/mv-dst.txt" },
      ctx,
    );
    assert.equal(r.ok, true);
    const c = await registry.execute("file_read", { path: "subdir/mv-dst.txt" }, ctx);
    assert.ok(c.content.includes("moved"));
  });
});

/* ---------------------------------------------------------------- file_copy */

describe("file_copy", () => {
  it("copies a file", async () => {
    const ctx = makeCtx();
    await registry.execute("file_write", { path: "copy-src.txt", content: "original" }, ctx);
    const r = await registry.execute(
      "file_copy",
      { source: "copy-src.txt", destination: "copy-dst.txt" },
      ctx,
    );
    assert.equal(r.ok, true);
    const src = await registry.execute("file_read", { path: "copy-src.txt" }, ctx);
    const dst = await registry.execute("file_read", { path: "copy-dst.txt" }, ctx);
    assert.ok(src.content.includes("original"));
    assert.ok(dst.content.includes("original"));
  });
});

/* --------------------------------------------------------------- file_delete */

describe("file_delete", () => {
  it("deletes a file", async () => {
    const ctx = makeCtx();
    await registry.execute("file_write", { path: "del.txt", content: "bye" }, ctx);
    const r = await registry.execute("file_delete", { path: "del.txt" }, ctx);
    assert.equal(r.ok, true);
    const read = await registry.execute("file_read", { path: "del.txt" }, ctx);
    assert.equal(read.ok, false);
  });

  it("refuses to delete a directory without recursive", async () => {
    const ctx = makeCtx();
    const dirPath = join(tmpDir, "del-dir");
    await mkdir(dirPath, { recursive: true });
    const r = await registry.execute("file_delete", { path: "del-dir" }, ctx);
    assert.equal(r.ok, false);
    assert.ok(r.error?.includes("directory") || r.error?.includes("recursive"));
  });

  it("deletes a directory with recursive=true", async () => {
    const ctx = makeCtx();
    const dirPath = join(tmpDir, "del-dir-recursive");
    await mkdir(join(dirPath, "nested"), { recursive: true });
    await writeFile(join(dirPath, "nested", "file.txt"), "content");
    const r = await registry.execute(
      "file_delete",
      { path: "del-dir-recursive", recursive: true },
      ctx,
    );
    assert.equal(r.ok, true);
  });
});

/* ------------------------------------------------------------ directory_list */

describe("directory_list", () => {
  it("lists a directory recursively", async () => {
    const ctx = makeCtx();
    const base = join(tmpDir, "listing");
    await mkdir(join(base, "sub"), { recursive: true });
    await writeFile(join(base, "root.txt"), "r");
    await writeFile(join(base, "sub", "nested.txt"), "n");

    const r = await registry.execute(
      "directory_list",
      { path: "listing", recursive: true },
      ctx,
    );
    assert.equal(r.ok, true);
    assert.ok(r.content.includes("root.txt"));
    assert.ok(r.content.includes("nested.txt"));
  });

  it("non-recursive list does not include nested files", async () => {
    const ctx = makeCtx();
    const base = join(tmpDir, "listing-shallow");
    await mkdir(join(base, "deep"), { recursive: true });
    await writeFile(join(base, "top.txt"), "t");
    await writeFile(join(base, "deep", "bottom.txt"), "b");

    const r = await registry.execute(
      "directory_list",
      { path: "listing-shallow", recursive: false },
      ctx,
    );
    assert.equal(r.ok, true);
    assert.ok(r.content.includes("top.txt"));
    assert.ok(!r.content.includes("bottom.txt"));
  });
});

/* --------------------------------------------------------------- glob_match */

describe("glob_match", () => {
  it("matches ** pattern", async () => {
    const ctx = makeCtx();
    const base = join(tmpDir, "glob-test");
    await mkdir(join(base, "src", "lib"), { recursive: true });
    await writeFile(join(base, "src", "index.ts"), "");
    await writeFile(join(base, "src", "lib", "util.ts"), "");
    await writeFile(join(base, "README.md"), "");

    const r = await registry.execute(
      "glob_match",
      { pattern: "**/*.ts", root: "glob-test" },
      ctx,
    );
    assert.equal(r.ok, true);
    assert.ok(r.content.includes("index.ts"));
    assert.ok(r.content.includes("util.ts"));
    assert.ok(!r.content.includes("README.md"));
  });

  it("matches {a,b} alternation", async () => {
    const ctx = makeCtx();
    const base = join(tmpDir, "glob-alt");
    await mkdir(base, { recursive: true });
    await writeFile(join(base, "index.ts"), "");
    await writeFile(join(base, "style.css"), "");
    await writeFile(join(base, "data.json"), "");

    const r = await registry.execute(
      "glob_match",
      { pattern: "*.{ts,css}", root: "glob-alt" },
      ctx,
    );
    assert.equal(r.ok, true);
    assert.ok(r.content.includes("index.ts"));
    assert.ok(r.content.includes("style.css"));
    assert.ok(!r.content.includes("data.json"));
  });
});

/* -------------------------------------------------------------- file_search */

describe("file_search", () => {
  it("finds text matches", async () => {
    const ctx = makeCtx();
    const base = join(tmpDir, "search-test");
    await mkdir(base, { recursive: true });
    await writeFile(join(base, "a.txt"), "hello world\nfoo bar\n");
    await writeFile(join(base, "b.txt"), "no match here\n");

    const r = await registry.execute(
      "file_search",
      { pattern: "hello", path: "search-test" },
      ctx,
    );
    assert.equal(r.ok, true);
    assert.ok(r.content.includes("a.txt"));
    assert.ok(r.content.includes("hello world"));
  });

  it("skips binary files", async () => {
    const ctx = makeCtx();
    const base = join(tmpDir, "search-binary");
    await mkdir(base, { recursive: true });
    // Write a binary file with NUL bytes
    const binBuf = Buffer.alloc(100);
    binBuf[10] = 0; // NUL byte
    await writeFile(join(base, "bin.dat"), binBuf);
    await writeFile(join(base, "text.txt"), "findme");

    const r = await registry.execute(
      "file_search",
      { pattern: "findme", path: "search-binary" },
      ctx,
    );
    assert.equal(r.ok, true);
    assert.ok(r.content.includes("text.txt"));
    assert.ok(!r.content.includes("bin.dat"));
  });
});

/* --------------------------------------------------------- path escape tests */

describe("path escape rejection", () => {
  it("rejects ../ escape attempts", async () => {
    const ctx = makeCtx();
    const r = await registry.execute("file_read", { path: "../../../etc/passwd" }, ctx);
    assert.equal(r.ok, false);
    assert.ok(
      r.error?.includes("escapes") || r.error?.includes("PATH_DENIED") || r.error?.includes("working folder"),
    );
  });

  it("rejects symlink escape attempts", async () => {
    const ctx = makeCtx();
    // Create a symlink inside tmpDir that points outside it
    const linkPath = join(tmpDir, "evil-link");
    try {
      await symlink("/tmp", linkPath);
    } catch {
      // If symlink creation fails (e.g. permissions), skip gracefully
      return;
    }
    const r = await registry.execute("file_read", { path: "evil-link/something" }, ctx);
    assert.equal(r.ok, false);
    assert.ok(
      r.error?.includes("escapes") || r.error?.includes("PATH_DENIED") || r.error?.includes("working folder"),
    );
  });
});

/* --------------------------------------------------------------- env_get / env_set */

describe("env tools", () => {
  it("env_set and env_get round-trip", async () => {
    const ctx = makeCtx();
    const name = "KOZUM_TEST_VAR_" + Date.now();

    const setR = await registry.execute("env_set", { name, value: "hello-env" }, ctx);
    assert.equal(setR.ok, true);

    const getR = await registry.execute("env_get", { name }, ctx);
    assert.equal(getR.ok, true);
    assert.equal(getR.content, "hello-env");
  });

  it("env_get fails for unset variable", async () => {
    const ctx = makeCtx();
    const r = await registry.execute("env_get", { name: "KOZUM_DEFINITELY_NOT_SET_XYZ123" }, ctx);
    assert.equal(r.ok, false);
  });
});

/* --------------------------------------------------------------- create/delete dir */

describe("directory_create + directory_delete", () => {
  it("creates and deletes nested directories", async () => {
    const ctx = makeCtx();
    const r = await registry.execute(
      "directory_create",
      { path: "created/deep/path" },
      ctx,
    );
    assert.equal(r.ok, true);

    const listR = await registry.execute(
      "directory_list",
      { path: "created", recursive: true },
      ctx,
    );
    assert.equal(listR.ok, true);

    const delR = await registry.execute(
      "directory_delete",
      { path: "created" },
      ctx,
    );
    assert.equal(delR.ok, true);
  });
});
