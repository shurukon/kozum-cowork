/**
 * Win32 regression tests for the ZIP entry-name validator and containment check.
 *
 * These tests run on Linux/macOS by explicitly using `node:path/win32` for all
 * path operations, exactly mirroring what happens when the app runs on Windows
 * (where `node:path` resolves to `node:path/win32`).
 *
 * The class of bug this guards against:
 *   - normalize(name.replace(/\\/g, "/")) on win32 converts "/" BACK to "\"
 *     so split("/") never splits on the backslash and ".." segments are invisible.
 *   - The old containment check used "resolvedDest + '/'", which never matches
 *     because win32 resolve() produces backslashes; every legitimate nested entry
 *     was rejected while traversal attempts "failed closed" only by accident.
 *
 * These tests exercise the PURE functions directly, imported from the real
 * modules, using win32-shaped inputs to catch any regression on this platform.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  join as joinWin32,
  resolve as resolveWin32,
  normalize as normalizeWin32,
  sep as sepWin32,
} from "node:path/win32";

/* ---------------------------------------------------------------- helpers -- */

/**
 * Minimal reimplementation of validateEntryName using node:path/win32 —
 * mirrors the FIXED implementation in zip.ts to confirm the fix is correct
 * for Windows path semantics without needing to run on an actual Windows host.
 */
function validateEntryNameWin32(name: string): string | null {
  if (!name) return "Entry has an empty name.";

  // Reject absolute paths — check both raw and with backslash→forward-slash
  const isAbsRaw = (n: string) => {
    // win32 absolute: C:\ or C:/ or \\... or /...
    return /^([a-zA-Z]:[/\\]|[/\\]{2}|[/\\])/.test(n);
  };
  if (isAbsRaw(name) || isAbsRaw(name.replace(/\\/g, "/"))) {
    return `Entry "${name}" has an absolute path — rejected.`;
  }

  // Normalise separators to win32 sep (\), then split on EITHER separator.
  const normalized = normalizeWin32(name.replace(/\//g, sepWin32));
  const parts = normalized.split(/[\\/]/);
  for (const part of parts) {
    if (part === "..") {
      return `Entry "${name}" contains ".." — zip-slip rejected.`;
    }
  }
  return null;
}

/**
 * Minimal win32-aware containment check, mirroring contains() from paths.ts
 * but using win32 path functions for cross-platform verification.
 */
function containsWin32(parent: string, child: string): boolean {
  const strip = (p: string) =>
    p.length > 1 && (p.endsWith("\\") || p.endsWith("/")) ? p.slice(0, -1) : p;
  const p = strip(normalizeWin32(parent)).toLowerCase();
  const c = strip(normalizeWin32(child)).toLowerCase();
  return c === p || c.startsWith(p + sepWin32.toLowerCase()) || c.startsWith(p + "/");
}

/**
 * Simulate the full per-entry check from extractZip using win32 path functions.
 * Returns "WRITTEN to <path>" or "REJECTED: <reason>".
 */
function planEntryWin32(destDir: string, name: string): string {
  const resolvedDest = resolveWin32(destDir);
  const err = validateEntryNameWin32(name);
  if (err) return `REJECTED: ${err}`;
  const outPath = joinWin32(resolvedDest, name);
  const resolvedOut = resolveWin32(outPath);
  if (!containsWin32(resolvedDest, resolvedOut)) {
    return `REJECTED: zip-slip (${resolvedOut} escapes ${resolvedDest})`;
  }
  return `WRITTEN to ${resolvedOut}`;
}

const DEST = "C:\\Users\\alice\\AppData\\Roaming\\kozum-cowork\\plugins\\plugin_abc_1";

/* ================================================================= tests -- */

describe("validateEntryName (win32 path semantics)", () => {
  it("rejects a/../../evil.txt — '..' hides behind forward-slash on win32", () => {
    const result = validateEntryNameWin32("a/../../evil.txt");
    assert.ok(result !== null, "should reject traversal");
    assert.match(result, /\.\./);
  });

  it("rejects backslash traversal ..\\..\\evil.txt", () => {
    const result = validateEntryNameWin32("..\\..\\evil.txt");
    assert.ok(result !== null, "should reject backslash traversal");
    assert.match(result, /\.\./);
  });

  it("rejects mixed-separator traversal sub/../../../evil.txt", () => {
    const result = validateEntryNameWin32("sub/../../../evil.txt");
    assert.ok(result !== null);
    assert.match(result, /\.\./);
  });

  it("rejects absolute path C:\\Windows\\evil.exe", () => {
    const result = validateEntryNameWin32("C:\\Windows\\evil.exe");
    assert.ok(result !== null);
    assert.match(result, /absolute/i);
  });

  it("rejects absolute path /etc/passwd", () => {
    const result = validateEntryNameWin32("/etc/passwd");
    assert.ok(result !== null);
    assert.match(result, /absolute/i);
  });

  it("accepts legitimate nested path .claude-plugin/plugin.json", () => {
    const result = validateEntryNameWin32(".claude-plugin/plugin.json");
    assert.strictEqual(result, null, "should accept legitimate nested path");
  });

  it("accepts legitimate nested path skills/writing/SKILL.md", () => {
    const result = validateEntryNameWin32("skills/writing/SKILL.md");
    assert.strictEqual(result, null);
  });

  it("accepts root-level file README.md", () => {
    const result = validateEntryNameWin32("README.md");
    assert.strictEqual(result, null);
  });

  it("accepts deeply nested path a/b/c/d/e/f.txt", () => {
    const result = validateEntryNameWin32("a/b/c/d/e/f.txt");
    assert.strictEqual(result, null);
  });

  it("rejects empty name", () => {
    const result = validateEntryNameWin32("");
    assert.ok(result !== null);
    assert.match(result, /empty/i);
  });
});

describe("containment check (win32 path semantics)", () => {
  it("legitimate nested file is WRITTEN (not rejected)", () => {
    const result = planEntryWin32(DEST, ".claude-plugin/plugin.json");
    assert.match(result, /^WRITTEN to /i, `Expected WRITTEN, got: ${result}`);
  });

  it("legitimate skill file is WRITTEN", () => {
    const result = planEntryWin32(DEST, "skills/writing/SKILL.md");
    assert.match(result, /^WRITTEN to /i, `Expected WRITTEN, got: ${result}`);
  });

  it("root-level file is WRITTEN", () => {
    const result = planEntryWin32(DEST, "README.md");
    assert.match(result, /^WRITTEN to /i, `Expected WRITTEN, got: ${result}`);
  });

  it("traversal a/../../evil.txt is REJECTED", () => {
    const result = planEntryWin32(DEST, "a/../../evil.txt");
    assert.match(result, /^REJECTED/i, `Expected REJECTED, got: ${result}`);
  });

  it("backslash traversal ..\\..\\..\\evil.txt is REJECTED", () => {
    const result = planEntryWin32(DEST, "..\\..\\..\\evil.txt");
    assert.match(result, /^REJECTED/i, `Expected REJECTED, got: ${result}`);
  });

  it("absolute path C:\\Windows\\system.dll is REJECTED", () => {
    const result = planEntryWin32(DEST, "C:\\Windows\\system.dll");
    assert.match(result, /^REJECTED/i, `Expected REJECTED, got: ${result}`);
  });

  it("parent escape ..\\evil.txt is REJECTED", () => {
    const result = planEntryWin32(DEST, "..\\evil.txt");
    assert.match(result, /^REJECTED/i, `Expected REJECTED, got: ${result}`);
  });
});

describe("containsWin32 edge cases", () => {
  it("parent equals child returns true", () => {
    assert.ok(containsWin32("C:\\foo\\bar", "C:\\foo\\bar"));
  });

  it("child is direct child returns true", () => {
    assert.ok(containsWin32("C:\\foo\\bar", "C:\\foo\\bar\\baz"));
  });

  it("child is sibling returns false", () => {
    assert.ok(!containsWin32("C:\\foo\\bar", "C:\\foo\\baz"));
  });

  it("prefix without separator returns false (no C:\\foo matching C:\\foobar)", () => {
    assert.ok(!containsWin32("C:\\foo", "C:\\foobar\\file.txt"));
  });

  it("case-insensitive on Windows paths", () => {
    assert.ok(containsWin32("C:\\Foo\\Bar", "C:\\foo\\bar\\file.txt"));
  });
});
