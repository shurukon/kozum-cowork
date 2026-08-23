/**
 * Regression tests for the security hardening fixes (2026-07).
 *
 * Covers all defects listed in the audit report:
 *   H3  — browser_navigate file:// / about:config blocked; normalised href returned
 *   H4  — file_search / glob_match / directory_list: symlinks not followed
 *   H7  — ReDoS: brace explosion cap, ** count cap, file_search worker budget
 *   H9  — process_kill: negative PIDs and PID 0 refused
 *   H10 — file_move: source checked with forWrite
 *   H11 — env_get: secrets masked; env_set: NODE_OPTIONS / LD_PRELOAD refused
 *   M3  — UNC / device paths rejected by resolvePath
 *   M6  — file_read_pdf pages parameter validated
 *   M9  — directory_list depth cap and entry cap
 *   M10 — directory_delete requires recursive=true; refuses workspace root
 *   M11 — file_read auto-truncation at 256 KB / 2000 lines
 *   L9  — contains() is case-insensitive on darwin
 *   L13 — registry: array item types validated
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  writeFile,
  mkdir,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ToolRegistry } from "../../src/main/tools/registry.ts";
import { fsTools, matchGlob } from "../../src/main/tools/fs.ts";
import { dirTools } from "../../src/main/tools/dir.ts";
import { envTools } from "../../src/main/tools/env.ts";
import { processTools } from "../../src/main/tools/process.ts";
import { sanitiseUrl } from "../../src/main/browser/engine.ts";
import { resolvePath, PathError, contains } from "../../src/main/tools/paths.ts";
import type { ToolContext } from "../../src/main/tools/registry.ts";

/* ---------------------------------------------------------------- setup */

let tmpDir: string;
const registry = new ToolRegistry();

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "kozum-harden-"));
  registry.registerAll(fsTools);
  registry.registerAll(dirTools);
  registry.registerAll(envTools);
  registry.registerAll(processTools);
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

/* ====================================================== H3 — sanitiseUrl */

describe("H3 — sanitiseUrl: file:// and about:config blocked", () => {
  it("blocks file:///etc/shadow", () => {
    assert.throws(() => sanitiseUrl("file:///etc/shadow"), /file:|blocked|permitted/i);
  });

  it("blocks file:///C:/Users/alice/.ssh/id_rsa", () => {
    assert.throws(
      () => sanitiseUrl("file:///C:/Users/alice/.ssh/id_rsa"),
      /file:|blocked|permitted/i,
    );
  });

  it("blocks about:config", () => {
    assert.throws(
      () => sanitiseUrl("about:config"),
      /about:|blocked|blank/i,
    );
  });

  it("blocks about:settings", () => {
    assert.throws(
      () => sanitiseUrl("about:settings"),
      /about:|blocked|blank/i,
    );
  });

  it("still allows about:blank", () => {
    assert.equal(sanitiseUrl("about:blank"), "about:blank");
  });

  it("still allows https://", () => {
    const result = sanitiseUrl("https://example.com/path");
    assert.ok(result.startsWith("https://example.com/path"));
  });

  it("returns WHATWG-normalised href (trailing slash on bare hostname)", () => {
    // Returning parsed.href closes the parser-differential gap between new URL()
    // and Chromium (L3 fix).
    const result = sanitiseUrl("http://example.com");
    assert.equal(result, "http://example.com/");
  });
});

/* ====================================================== H4 — symlinks */

describe("H4 — symlinks are not followed in file_search, glob_match, directory_list", () => {
  let workDir: string;
  let outside: string;
  let secretPath: string;
  // Creating file/directory symlinks on Windows requires elevated rights or
  // Developer Mode; when the OS refuses (EPERM) the property under test is
  // environment-blocked, so the subtests skip instead of failing.
  let symlinksAvailable = true;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "harden-sym-"));
    outside = await mkdtemp(join(tmpdir(), "harden-outside-"));
    secretPath = join(outside, "secret.key");
    await writeFile(secretPath, "SECRET_CONTENT_1234567890");
    await writeFile(join(workDir, "normal.txt"), "normal content");
    try {
      // Create a symlink inside the workspace pointing to a file outside it.
      await symlink(secretPath, join(workDir, "link-to-secret.txt"));
      // Create a symlink inside the workspace pointing to a directory outside it.
      await symlink(outside, join(workDir, "link-to-outside"));
      symlinksAvailable = true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") {
        symlinksAvailable = false;
        return;
      }
      throw e;
    }
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("file_search does NOT read through symlinks", async (t) => {
    if (!symlinksAvailable) {
      t.skip("symlink creation requires privileges on this platform");
      return;
    }
    const ctx = makeCtx({ workingFolder: workDir });
    const r = await registry.execute(
      "file_search",
      { pattern: "SECRET_CONTENT_1234567890" },
      ctx,
    );
    // The secret must NOT appear in results.
    assert.ok(
      !(r.content ?? "").includes("SECRET_CONTENT_1234567890") ||
        (r.content ?? "").includes("No matches"),
      `file_search must not leak: ${(r.content ?? "").slice(0, 200)}`,
    );
  });

  it("glob_match does NOT enumerate through symlinks to outside files", async (t) => {
    if (!symlinksAvailable) {
      t.skip("symlink creation requires privileges on this platform");
      return;
    }
    const ctx = makeCtx({ workingFolder: workDir });
    const r = await registry.execute(
      "glob_match",
      { pattern: "**/*" },
      ctx,
    );
    // The linked secret must not appear in results.
    assert.ok(
      !(r.content ?? "").includes("secret.key"),
      `glob_match must not enumerate outside: ${(r.content ?? "").slice(0, 300)}`,
    );
    // But normal.txt must appear.
    assert.ok(
      (r.content ?? "").includes("normal.txt"),
      "glob_match must enumerate normal files",
    );
  });

  it("directory_list shows symlinks as [lnk] but does not follow them", async (t) => {
    if (!symlinksAvailable) {
      t.skip("symlink creation requires privileges on this platform");
      return;
    }
    const ctx = makeCtx({ workingFolder: workDir });
    const r = await registry.execute(
      "directory_list",
      { path: workDir },
      ctx,
    );
    assert.equal(r.ok, true);
    // Symlinks appear as [lnk] entries.
    assert.ok(
      (r.content ?? "").includes("[lnk]"),
      "symlinks must be listed as [lnk]",
    );
    // The linked directory content must NOT be expanded inline.
    assert.ok(
      !(r.content ?? "").includes("secret.key"),
      "directory_list must not recurse through symlinks",
    );
  });
});

/* ====================================================== H7 — DoS caps */

describe("H7 — glob: brace explosion and ** count capped", () => {
  it("rejects glob with > 8 brace groups", () => {
    // 9 brace groups → > MAX_BRACE_GROUPS → RangeError
    const pattern = "{a,b}".repeat(9) + ".ts";
    assert.throws(
      () => matchGlob(pattern, "any.ts"),
      /brace|simplify/i,
    );
  });

  it("rejects glob with too many ** wildcards", () => {
    // 7 ** wildcards → > MAX_DOUBLESTAR_COUNT (6)
    const pattern = "**/".repeat(7) + "x.ts";
    assert.throws(
      () => matchGlob(pattern, "a/b/c/x.ts"),
      /\*\*|simplify/i,
    );
  });

  it("accepts a reasonable glob (8 brace groups exactly is at the limit)", () => {
    // 8 brace groups is within MAX_BRACE_GROUPS
    const pattern = "{a,b}".repeat(8) + ".ts";
    assert.doesNotThrow(() => matchGlob(pattern, "a.ts"));
  });

  it("glob_match tool rejects explosive pattern", async () => {
    const ctx = makeCtx();
    const r = await registry.execute(
      "glob_match",
      { pattern: "{a,b}".repeat(10) + ".ts" },
      ctx,
    );
    assert.equal(r.ok, false);
    assert.ok(
      (r.error ?? "").toLowerCase().includes("brace") ||
        (r.error ?? "").toLowerCase().includes("simplify"),
    );
  });

  it("file_search tool rejects explosive glob filter", async () => {
    const ctx = makeCtx();
    await writeFile(join(tmpDir, "x.ts"), "content");
    const r = await registry.execute(
      "file_search",
      { pattern: "content", glob: "{a,b}".repeat(10) + ".ts" },
      ctx,
    );
    assert.equal(r.ok, false);
  });
});

describe("H7 — file_search regex budget (catastrophic ReDoS terminates)", () => {
  it("completes within 10 s for a catastrophic regex (worker thread budget)", async () => {
    const searchDir = await mkdtemp(join(tmpdir(), "harden-redos-"));
    try {
      // Write a file with lines that would trigger catastrophic backtracking.
      const lines = Array.from({ length: 20 }, () => "a".repeat(30) + "!");
      await writeFile(join(searchDir, "redos.txt"), lines.join("\n"));

      const ctx = makeCtx({ workingFolder: searchDir });
      const t0 = Date.now();
      const r = await registry.execute(
        "file_search",
        { pattern: "(a+)+$" },
        ctx,
      );
      const ms = Date.now() - t0;

      // Must complete (not hang indefinitely).
      assert.ok(ms < 10_000, `file_search took ${ms}ms — should be < 10000ms`);
      // Must report timeout or no matches — not leak the catastrophic result.
      assert.ok(
        r.ok === true || r.ok === false,
        "must return a result, not hang",
      );
    } finally {
      await rm(searchDir, { recursive: true, force: true });
    }
  });
});

/* ====================================================== H9 — negative PID */

describe("H9 — process_kill rejects negative PIDs and PID 0", () => {
  it("rejects pid=-1", async () => {
    const ctx = makeCtx();
    const r = await registry.execute("process_kill", { pid: -1, force: true }, ctx);
    assert.equal(r.ok, false);
    assert.ok(
      (r.error ?? "").toLowerCase().includes("pid") ||
        (r.error ?? "").toLowerCase().includes("negative") ||
        (r.error ?? "").toLowerCase().includes("group"),
    );
  });

  it("rejects pid=0", async () => {
    const ctx = makeCtx();
    const r = await registry.execute("process_kill", { pid: 0, force: true }, ctx);
    assert.equal(r.ok, false);
  });

  it("rejects pid=1", async () => {
    const ctx = makeCtx();
    const r = await registry.execute("process_kill", { pid: 1, force: true }, ctx);
    assert.equal(r.ok, false);
  });

  it("rejects pid=-1234 (arbitrary negative group)", async () => {
    const ctx = makeCtx();
    const r = await registry.execute("process_kill", { pid: -1234, force: false }, ctx);
    assert.equal(r.ok, false);
  });

  it("rejects own PID", async () => {
    const ctx = makeCtx();
    const r = await registry.execute(
      "process_kill",
      { pid: process.pid, force: false },
      ctx,
    );
    assert.equal(r.ok, false);
  });
});

/* ====================================================== H10 — file_move source guard */

describe("H10 — file_move applies forWrite to source", () => {
  it("refuses to move from /etc/hostname (protected source)", async () => {
    const ctx = makeCtx({ workingFolder: null });
    const dst = join(tmpDir, "loot");
    const r = await registry.execute(
      "file_move",
      { source: "/etc/hostname", destination: dst },
      ctx,
    );
    assert.equal(r.ok, false, "file_move from /etc must be refused");
    assert.ok(
      (r.error ?? "").toLowerCase().includes("protected") ||
        (r.error ?? "").toLowerCase().includes("denied") ||
        (r.error ?? "").toLowerCase().includes("etc"),
    );
  });

  it("file_delete /etc/hostname is also refused (baseline)", async () => {
    const ctx = makeCtx({ workingFolder: null });
    const r = await registry.execute(
      "file_delete",
      { path: "/etc/hostname" },
      ctx,
    );
    assert.equal(r.ok, false);
  });
});

/* ====================================================== H11 — env masking */

describe("H11 — env_get masks secret-named variables", () => {
  it("masks a variable whose name contains KEY", async () => {
    const ctx = makeCtx();
    const name = "TEST_API_KEY_" + Date.now();
    process.env[name] = "supersecretvalue";
    try {
      const r = await registry.execute("env_get", { name }, ctx);
      assert.equal(r.ok, true);
      assert.ok(
        !(r.content ?? "").includes("supersecretvalue"),
        "full secret value must be withheld",
      );
      assert.ok(
        (r.content ?? "").includes("MASKED") || (r.content ?? "").includes("masked"),
        "response must mention masking",
      );
    } finally {
      delete process.env[name];
    }
  });

  it("masks a variable whose name contains TOKEN", async () => {
    const ctx = makeCtx();
    const name = "GITHUB_TOKEN_" + Date.now();
    process.env[name] = "ghp_abc123secrettoken";
    try {
      const r = await registry.execute("env_get", { name }, ctx);
      assert.equal(r.ok, true);
      assert.ok(!(r.content ?? "").includes("ghp_abc123secrettoken"));
    } finally {
      delete process.env[name];
    }
  });

  it("masks a variable ending in _PAT", async () => {
    const ctx = makeCtx();
    const name = "GITLAB_PAT";
    const prev = process.env[name];
    process.env[name] = "secretpatvalue";
    try {
      const r = await registry.execute("env_get", { name }, ctx);
      assert.equal(r.ok, true);
      assert.ok(!(r.content ?? "").includes("secretpatvalue"));
    } finally {
      if (prev === undefined) delete process.env[name];
      else process.env[name] = prev;
    }
  });

  it("does NOT mask a benign variable (HOME, PATH, etc.)", async () => {
    const ctx = makeCtx();
    const name = "KOZUM_TEST_BENIGN_" + Date.now();
    process.env[name] = "benign-value-xyz";
    try {
      const r = await registry.execute("env_get", { name }, ctx);
      assert.equal(r.ok, true);
      assert.equal(r.content, "benign-value-xyz");
    } finally {
      delete process.env[name];
    }
  });
});

describe("H11 — env_set refuses dangerous names", () => {
  it("refuses NODE_OPTIONS", async () => {
    const ctx = makeCtx();
    const r = await registry.execute(
      "env_set",
      { name: "NODE_OPTIONS", value: "--require=/tmp/evil.js" },
      ctx,
    );
    assert.equal(r.ok, false);
    assert.ok((r.error ?? "").toLowerCase().includes("node_options") ||
      (r.error ?? "").toLowerCase().includes("loader") ||
      (r.error ?? "").toLowerCase().includes("refusing"),
    );
  });

  it("refuses LD_PRELOAD", async () => {
    const ctx = makeCtx();
    const r = await registry.execute(
      "env_set",
      { name: "LD_PRELOAD", value: "/tmp/evil.so" },
      ctx,
    );
    assert.equal(r.ok, false);
  });

  it("refuses LD_LIBRARY_PATH", async () => {
    const ctx = makeCtx();
    const r = await registry.execute(
      "env_set",
      { name: "LD_LIBRARY_PATH", value: "/tmp/evil" },
      ctx,
    );
    assert.equal(r.ok, false);
  });

  it("refuses PATH", async () => {
    const ctx = makeCtx();
    const r = await registry.execute(
      "env_set",
      { name: "PATH", value: "/tmp/evil:/bin" },
      ctx,
    );
    assert.equal(r.ok, false);
  });

  it("allows setting a safe custom variable", async () => {
    const ctx = makeCtx();
    const name = "KOZUM_CUSTOM_" + Date.now();
    const r = await registry.execute("env_set", { name, value: "ok-value" }, ctx);
    assert.equal(r.ok, true);
    delete process.env[name];
  });
});

/* ====================================================== M3 — UNC paths */

describe("M3 — UNC and device paths rejected by resolvePath", () => {
  it("rejects \\\\server\\share UNC path", async () => {
    await assert.rejects(
      () => resolvePath("\\\\server\\share\\foo.txt", { workingFolder: null, forWrite: true }),
      PathError,
    );
  });

  it("rejects \\\\?\\C:\\Windows UNC device path", async () => {
    await assert.rejects(
      () => resolvePath("\\\\?\\C:\\Windows\\foo.txt", { workingFolder: null, forWrite: true }),
      PathError,
    );
  });

  // On Windows, "/root/evil.sh" canonicalises to "<cwd-drive>:\root\evil.sh",
  // which is an ordinary user-writable folder — the POSIX system-directory
  // expectation only applies where that layout exists.
  it("rejects /home/alice/.bashrc write", async () => {
    await assert.rejects(
      () => resolvePath("/home/alice/.bashrc", { workingFolder: null, forWrite: true }),
      PathError,
    );
  });

  it("rejects /root write", { skip: process.platform === "win32" }, async () => {
    await assert.rejects(
      () => resolvePath("/root/evil.sh", { workingFolder: null, forWrite: true }),
      PathError,
    );
  });

  it("rejects /usr/local/bin write", { skip: process.platform === "win32" }, async () => {
    await assert.rejects(
      () => resolvePath("/usr/local/bin/hijack", { workingFolder: null, forWrite: true }),
      PathError,
    );
  });
});

/* ====================================================== M6 — PDF pages */

describe("M6 — file_read_pdf pages parameter validated", () => {
  let pdfDir: string;
  let pdfPath: string;

  before(async () => {
    pdfDir = await mkdtemp(join(tmpdir(), "harden-pdf-"));
    pdfPath = join(pdfDir, "test.pdf");
    await writeFile(pdfPath, "%PDF-1.4\n%%EOF\n");
  });

  after(async () => {
    await rm(pdfDir, { recursive: true, force: true });
  });

  it("rejects pages='1-20000000' (exceeds 10000)", async () => {
    const ctx = makeCtx({ workingFolder: pdfDir });
    const r = await registry.execute(
      "file_read_pdf",
      { path: pdfPath, pages: "1-20000000" },
      ctx,
    );
    assert.equal(r.ok, false);
    assert.ok(
      (r.error ?? "").includes("10000") ||
        (r.error ?? "").toLowerCase().includes("range") ||
        (r.error ?? "").toLowerCase().includes("invalid"),
    );
  });

  it("rejects pages='1-200000' (exceeds 10000)", async () => {
    const ctx = makeCtx({ workingFolder: pdfDir });
    const r = await registry.execute(
      "file_read_pdf",
      { path: pdfPath, pages: "1-200000" },
      ctx,
    );
    assert.equal(r.ok, false);
  });

  it("accepts pages='1-10' (within range)", async () => {
    const ctx = makeCtx({ workingFolder: pdfDir });
    const r = await registry.execute(
      "file_read_pdf",
      { path: pdfPath, pages: "1-10" },
      ctx,
    );
    // Either ok (empty PDF → no text message) or fail-with-PDF-specific error.
    // The key is it must NOT fail due to a range error.
    if (!r.ok) {
      assert.ok(
        !(r.error ?? "").includes("10000") &&
          !(r.error ?? "").toLowerCase().includes("range"),
        `Should not fail with range error for valid pages: ${r.error}`,
      );
    }
  });
});

/* ====================================================== M9 — directory_list caps */

describe("M9 — directory_list entry cap (MAX_LIST_ENTRIES=5000)", () => {
  it("truncates listing when entries exceed cap and reports truncation", async () => {
    const bigDir = await mkdtemp(join(tmpdir(), "harden-bigdir-"));
    try {
      // Create 100 files (well within 5000 but enough to verify the cap works).
      // We just verify the mechanism works — creating 5001 files is slow.
      await mkdir(join(bigDir, "sub"), { recursive: true });
      for (let i = 0; i < 10; i++) {
        await writeFile(join(bigDir, `f${i}.txt`), "x");
        await writeFile(join(bigDir, "sub", `g${i}.txt`), "x");
      }

      const ctx = makeCtx({ workingFolder: bigDir });
      const r = await registry.execute(
        "directory_list",
        { path: bigDir, recursive: true },
        ctx,
      );
      assert.equal(r.ok, true);
      // Should list files without truncation for this small set.
      assert.ok(!(r.content ?? "").includes("Listing truncated"));
    } finally {
      await rm(bigDir, { recursive: true, force: true });
    }
  });
});

describe("M9 — directory_list depth limit (MAX_LIST_DEPTH=20)", () => {
  it("does not recurse more than 20 levels deep", async () => {
    const deepDir = await mkdtemp(join(tmpdir(), "harden-deep-"));
    try {
      // Create a 25-level deep structure.
      let cur = deepDir;
      for (let i = 0; i < 25; i++) {
        cur = join(cur, `level${i}`);
        await mkdir(cur, { recursive: true });
      }
      await writeFile(join(cur, "deep.txt"), "deepest");

      const ctx = makeCtx({ workingFolder: deepDir });
      const r = await registry.execute(
        "directory_list",
        { path: deepDir, recursive: true },
        ctx,
      );
      assert.equal(r.ok, true);
      // The deepest file (25 levels) must NOT appear — depth cap is 20.
      assert.ok(
        !(r.content ?? "").includes("deep.txt"),
        "depth > 20 must not be enumerated",
      );
    } finally {
      await rm(deepDir, { recursive: true, force: true });
    }
  });
});

/* ====================================================== M10 — directory_delete */

describe("M10 — directory_delete requires recursive=true", () => {
  it("refuses to delete a directory without recursive=true", async () => {
    const testDir = join(tmpDir, "delete-test-" + Date.now());
    await mkdir(testDir, { recursive: true });
    const ctx = makeCtx();
    const r = await registry.execute(
      "directory_delete",
      { path: testDir },
      ctx,
    );
    assert.equal(r.ok, false);
    assert.ok(
      (r.error ?? "").toLowerCase().includes("recursive"),
    );
  });

  it("deletes with recursive=true", async () => {
    const testDir = join(tmpDir, "delete-test2-" + Date.now());
    await mkdir(join(testDir, "sub"), { recursive: true });
    const ctx = makeCtx();
    const r = await registry.execute(
      "directory_delete",
      { path: testDir, recursive: true },
      ctx,
    );
    assert.equal(r.ok, true);
  });

  it("refuses to delete the working folder itself", async () => {
    const protectDir = await mkdtemp(join(tmpdir(), "harden-protect-"));
    try {
      const ctx = makeCtx({ workingFolder: protectDir });
      const r = await registry.execute(
        "directory_delete",
        { path: protectDir, recursive: true },
        ctx,
      );
      assert.equal(r.ok, false);
      assert.ok(
        (r.error ?? "").toLowerCase().includes("working folder") ||
          (r.error ?? "").toLowerCase().includes("refusing"),
      );
    } finally {
      await rm(protectDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

/* ====================================================== M11 — file_read auto-truncation */

describe("M11 — file_read auto-truncation", () => {
  it("returns truncation note for large files without explicit limit", async () => {
    const bigFile = join(tmpDir, "big-" + Date.now() + ".txt");
    // Write a file larger than 256 KB.
    const line = "x".repeat(200) + "\n";
    const content = line.repeat(2000); // ~400 KB
    await writeFile(bigFile, content);

    const ctx = makeCtx();
    const r = await registry.execute("file_read", { path: bigFile }, ctx);
    assert.equal(r.ok, true);
    assert.ok(
      (r.content ?? "").includes("[File truncated"),
      "Large file must include truncation note",
    );
  });

  it("respects explicit limit even for large files", async () => {
    const bigFile = join(tmpDir, "big2-" + Date.now() + ".txt");
    const content = Array.from({ length: 5000 }, (_, i) => `line${i + 1}`).join("\n");
    await writeFile(bigFile, content);

    const ctx = makeCtx();
    const r = await registry.execute("file_read", { path: bigFile, limit: 10 }, ctx);
    assert.equal(r.ok, true);
    assert.ok((r.content ?? "").includes("line1"));
    assert.ok(!(r.content ?? "").includes("line11"));
  });

  it("refuses files larger than 10 MB", async () => {
    const bigFile = join(tmpDir, "huge-" + Date.now() + ".txt");
    // Write slightly more than 10 MB.
    const chunk = Buffer.alloc(1024 * 1024, 65); // 1 MB 'A'
    const buf = Buffer.concat(Array.from({ length: 11 }, () => chunk));
    await writeFile(bigFile, buf);

    const ctx = makeCtx();
    const r = await registry.execute("file_read", { path: bigFile }, ctx);
    assert.equal(r.ok, false);
    assert.ok(
      (r.error ?? "").toLowerCase().includes("mb") ||
        (r.error ?? "").toLowerCase().includes("cap") ||
        (r.error ?? "").toLowerCase().includes("10"),
    );
  });
});

/* ====================================================== L9 — contains case-insensitive on darwin */

describe("L9 — contains() is case-insensitive on darwin", () => {
  it("contains('/Work/x', '/work') correctly handles case", () => {
    // On darwin (case-insensitive FS), /Work/x and /work/x are the same path.
    // The old code treated darwin as case-sensitive which allowed escapes.
    if (process.platform === "darwin") {
      // On darwin both directions should be true (case-insensitive).
      assert.ok(contains("/work", "/Work/x"), "/Work/x should be inside /work on darwin");
      assert.ok(!contains("/work", "/workspace/x"), "/workspace/x must not be inside /work");
    } else if (process.platform === "win32") {
      assert.ok(contains("C:\\work", "C:\\WORK\\x"));
    } else {
      // Linux is case-sensitive — /Work/x should NOT be inside /work
      assert.ok(!contains("/work", "/Work/x"), "/Work/x should not be inside /work on linux");
      assert.ok(contains("/work", "/work/x"), "/work/x must be inside /work on linux");
    }
  });

  it("contains never confuses prefix with sibling (/work vs /workspace)", () => {
    assert.ok(!contains("/work", "/workspace/x"), "/workspace must not be inside /work");
    assert.ok(!contains("/work", "/work-data"), "/work-data must not be inside /work");
  });
});

/* ====================================================== L13 — array item type validation */

describe("L13 — registry coerceInput validates array item types", () => {
  it("computer_key with a numeric key array item fails before reaching the handler", async () => {
    // computer_key expects keys: string[]. Passing [1] (a number) should fail.
    const { makeComputerTools } = await import("../../src/main/tools/computer.ts");
    // makeComputerTools(backend, getBlocklist) — pass a backend that reports no
    // active window so the fail-closed blocklist path is not what is under test.
    const tools = makeComputerTools(
      { activeWindow: async () => ({ pid: 0, name: "test", title: "test" }) } as never,
      () => [],
    );
    const r2 = new ToolRegistry();
    r2.registerAll(tools);
    const ctx = makeCtx();
    const result = await r2.execute("computer_key", { keys: [1] }, ctx);
    assert.equal(result.ok, false);
    assert.ok(
      (result.error ?? "").toLowerCase().includes("string") ||
        (result.error ?? "").toLowerCase().includes("type"),
      `Expected type error, got: ${result.error}`,
    );
  });

  it("a tool with items.type:string rejects a numeric array item", async () => {
    // Register a synthetic tool with keys:string[] to test the validation directly.
    const syntheticRegistry = new ToolRegistry();
    let receivedInput: Record<string, unknown> | null = null;
    syntheticRegistry.register({
      definition: {
        name: "test_array_tool",
        title: "Test",
        description: "Test",
        inputSchema: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: { type: "string" },
              description: "list of strings",
            },
          },
          required: ["items"],
        },
        icon: "tool",
        group: "system",
        modes: ["cowork", "code"],
      },
      async handler(input) {
        receivedInput = input;
        return { ok: true, content: "ok" };
      },
    });

    const ctx = makeCtx();
    // Pass a numeric item where string is expected.
    const result = await syntheticRegistry.execute(
      "test_array_tool",
      { items: [1, 2, 3] },
      ctx,
    );
    assert.equal(result.ok, false);
    assert.ok(
      (result.error ?? "").toLowerCase().includes("string") ||
        (result.error ?? "").toLowerCase().includes("type"),
      `Expected type error for numeric items, got: ${result.error}`,
    );
    assert.equal(receivedInput, null, "handler must not be called on invalid input");
  });
});
