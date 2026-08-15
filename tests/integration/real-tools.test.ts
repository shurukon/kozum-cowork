/**
 * Real tool integration tests.
 *
 * These tests deliberately use the production ToolRegistry and production
 * handlers. The only isolation is a temporary workspace owned by the test
 * process; no mocks or fake handlers are involved.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolRegistry, type ToolContext } from "../../src/main/tools/registry.ts";
import { fsTools } from "../../src/main/tools/fs.ts";
import { dirTools } from "../../src/main/tools/dir.ts";
import { processTools } from "../../src/main/tools/process.ts";
import { shellTools } from "../../src/main/tools/shell.ts";
import type { ModelCapabilities } from "../../src/shared/types.ts";

const CAPS: ModelCapabilities = {
  vision: "yes",
  tools: true,
  streaming: true,
  reasoning: false,
};

let workspace = "";
let registry: ToolRegistry;

function ctx(signal?: AbortSignal): ToolContext {
  return {
    sessionId: "real-tools-test",
    mode: "code",
    workingFolder: workspace,
    outputsDir: join(workspace, "outputs"),
    capabilities: CAPS,
    modelId: "integration-test-model",
    providerId: "integration-test-provider",
    signal: signal ?? new AbortController().signal,
    onProgress: () => undefined,
  };
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "kozum-real-tools-"));
  registry = new ToolRegistry().registerAll([...fsTools, ...dirTools, ...processTools, ...shellTools]);
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("real filesystem tools", () => {
  it("writes, appends, reads, edits, copies, moves, and deletes a real file", async () => {
    const original = join(workspace, "notes", "draft.txt");
    const copied = join(workspace, "notes", "copied.txt");
    const moved = join(workspace, "archive", "final.txt");
    const run = ctx();

    const written = await registry.execute(
      "file_write",
      { path: "notes/draft.txt", content: "alpha\nbeta" },
      run,
    );
    assert.ok(written.ok, written.error);
    assert.equal(await readFile(original, "utf8"), "alpha\nbeta");

    const appended = await registry.execute(
      "file_write",
      { path: "notes/draft.txt", content: "\ngamma", append: true },
      run,
    );
    assert.ok(appended.ok, appended.error);

    const read = await registry.execute("file_read", { path: "notes/draft.txt" }, run);
    assert.ok(read.ok, read.error);
    assert.equal(read.content, "alpha\nbeta\ngamma");

    const edited = await registry.execute(
      "file_edit",
      { path: "notes/draft.txt", oldString: "beta", newString: "BETA" },
      run,
    );
    assert.ok(edited.ok, edited.error);
    assert.equal(await readFile(original, "utf8"), "alpha\nBETA\ngamma");

    const copiedResult = await registry.execute(
      "file_copy",
      { source: "notes/draft.txt", destination: "notes/copied.txt" },
      run,
    );
    assert.ok(copiedResult.ok, copiedResult.error);
    assert.equal(await readFile(copied, "utf8"), "alpha\nBETA\ngamma");

    const movedResult = await registry.execute(
      "file_move",
      { source: "notes/copied.txt", destination: "archive/final.txt" },
      run,
    );
    assert.ok(movedResult.ok, movedResult.error);
    assert.equal(await readFile(moved, "utf8"), "alpha\nBETA\ngamma");
    await assert.rejects(() => stat(copied));

    const deleted = await registry.execute("file_delete", { path: "archive/final.txt" }, run);
    assert.ok(deleted.ok, deleted.error);
    await assert.rejects(() => stat(moved));
  });

  it("rejects traversal outside the session workspace for reads and writes", async () => {
    const run = ctx();
    const read = await registry.execute("file_read", { path: "../outside.txt" }, run);
    assert.equal(read.ok, false);
    assert.match(read.error ?? "", /workspace|outside|scope|working/i);

    const write = await registry.execute(
      "file_write",
      { path: "../should-not-exist.txt", content: "blocked" },
      run,
    );
    assert.equal(write.ok, false);
    assert.match(write.error ?? "", /workspace|outside|scope|working/i);
  });

  it("returns validation failures instead of throwing on malformed input", async () => {
    const run = ctx();
    const missing = await registry.execute("file_write", { path: "missing-content.txt" }, run);
    assert.equal(missing.ok, false);
    assert.match(missing.error ?? "", /content|required/i);

    const unknown = await registry.execute("file_does_not_exist", {}, run);
    assert.equal(unknown.ok, false);
    assert.match(unknown.error ?? "", /Unknown tool/i);
  });

  it("honours cancellation before dispatching a handler", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await registry.execute(
      "file_write",
      { path: "cancelled.txt", content: "must not be written" },
      ctx(controller.signal),
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /Cancelled/i);
    await assert.rejects(() => stat(join(workspace, "cancelled.txt")));
  });
});

describe("real directory tools", () => {
  it("creates and lists a real directory tree, then refuses unsafe deletion without confirmation", async () => {
    const run = ctx();
    const created = await registry.execute("directory_create", { path: "project/src" }, run);
    assert.ok(created.ok, created.error);

    const nested = await registry.execute(
      "file_write",
      { path: "project/src/index.ts", content: "export const ok = true;" },
      run,
    );
    assert.ok(nested.ok, nested.error);

    const listed = await registry.execute("directory_list", { path: "project", recursive: true }, run);
    assert.ok(listed.ok, listed.error);
    assert.match(listed.content, /src\//);
    assert.match(listed.content, /index\.ts/);

    const blocked = await registry.execute("directory_delete", { path: "project" }, run);
    assert.equal(blocked.ok, false);
    assert.match(blocked.error ?? "", /recursive=true/i);

    const deleted = await registry.execute("directory_delete", { path: "project", recursive: true }, run);
    assert.ok(deleted.ok, deleted.error);
    await assert.rejects(() => stat(join(workspace, "project")));
  });
});

describe("real process tools", () => {
  it("lists real operating-system processes and rejects protected PIDs", async () => {
    const run = ctx();
    const listed = await registry.execute("process_list", {}, run);
    assert.ok(listed.ok, listed.error);
    assert.match(listed.content, /PID\s+NAME/i);

    const blocked = await registry.execute("process_kill", { pid: 1 }, run);
    assert.equal(blocked.ok, false);
    assert.match(blocked.error ?? "", /refus|protected|PID 1/i);
  });
});

describe("real shell tool", () => {
  it("runs a real command in the session workspace and returns stdout", async () => {
    const result = await registry.execute(
      "shell_exec",
      { command: "printf 'kozum-shell-ok'", shell: "bash", timeoutSeconds: 5 },
      ctx(),
    );
    assert.ok(result.ok, result.error);
    assert.match(result.content, /kozum-shell-ok/);
    assert.match(result.content, /exit code: 0/);
  });
});
