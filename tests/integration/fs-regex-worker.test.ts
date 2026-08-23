/**
 * Integration tests for the file_search regex engine's Windows fix.
 *
 * On this Node/Electron build the old code spawned Workers inheriting parent
 * exec argv (--experimental-strip-types), which worker runtimes reject with
 * ERR_WORKER_INVALID_EXEC_ARGV — file_search died on every call. The fix
 * passes an explicit empty execArgv and falls back to capped in-thread regex
 * evaluation when a spawn fails, so search degrades gracefully instead of
 * erroring. These tests cover both paths against real temp files.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ToolRegistry } from "../../src/main/tools/registry.ts";
import { fsTools, inThreadRegexTest, _setRegexWorkerUnavailableForTests } from "../../src/main/tools/fs.ts";
import type { ToolContext } from "../../src/main/tools/registry.ts";

let tmpDir: string;
const registry = new ToolRegistry();

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "kozum-fssearch-"));
  registry.registerAll(fsTools);
  await writeFile(join(tmpDir, "alpha.txt"), "hello world\nKOZUM needle here\ndone\n");
  await writeFile(join(tmpDir, "beta.log"), "nothing to see\n");
});

after(async () => {
  _setRegexWorkerUnavailableForTests(false);
  await rm(tmpDir, { recursive: true, force: true });
});

function makeCtx(): ToolContext {
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
  };
}

type RegexResult = ReturnType<typeof inThreadRegexTest>;

function expectMatches(r: RegexResult): boolean[] {
  if ("matches" in r) return r.matches;
  throw new Error("unexpected timedOut");
}

describe("inThreadRegexTest (fallback evaluator)", () => {
  it("returns per-line matches", () => {
    const lines = ["no", "yes needle", "needle again", "nope"];
    const matches = expectMatches(inThreadRegexTest("needle", "", lines, 1000));
    assert.deepEqual(matches, [false, true, true, false]);
  });

  it("honours case-insensitive flags", () => {
    const matches = expectMatches(inThreadRegexTest("needle", "i", ["NEEDLE"], 1000));
    assert.deepEqual(matches, [true]);
  });

  it("returns all-false instead of throwing for an invalid pattern", () => {
    const matches = expectMatches(inThreadRegexTest("([unclosed", "", ["a", "b"], 1000));
    assert.deepEqual(matches, [false, false]);
  });

  it("reports timedOut immediately for a non-positive budget", () => {
    const result = inThreadRegexTest("a", "", Array.from({ length: 500 }, () => "a"), -1);
    assert.ok(!("matches" in result));
  });
});

describe("file_search via registry", () => {
  it("finds matches through the Worker path (explicit empty execArgv)", async () => {
    const r = await registry.execute(
      "file_search",
      { path: ".", pattern: "needle" },
      makeCtx(),
    );
    assert.equal(r.ok, true, `file_search failed: ${r.error ?? ""}`);
    assert.match(r.content, /alpha\.txt/);
    assert.match(r.content, /KOZUM needle here/);
  });

  it("still finds matches when Worker spawning is unavailable (fallback path)", async () => {
    _setRegexWorkerUnavailableForTests(true);
    try {
      const r = await registry.execute(
        "file_search",
        { path: ".", pattern: "needle", caseSensitive: false },
        makeCtx(),
      );
      assert.equal(r.ok, true, `file_search failed: ${r.error ?? ""}`);
      assert.match(r.content, /alpha\.txt/);
    } finally {
      _setRegexWorkerUnavailableForTests(false);
    }
  });
});
