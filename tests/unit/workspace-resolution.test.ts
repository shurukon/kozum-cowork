/**
 * Unit tests for the default-workspace resolution chain (Task 5).
 *
 *   session.workingFolder → defaultFolders[mode] → defaultWorkspace → cwd
 *
 * The shared workspace is the last explicit stop and is created lazily on
 * first use; it is changeable from Settings but never removable.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveWorkingFolder,
  ensureWorkspaceDir,
} from "../../src/main/session/workspace.ts";

describe("resolveWorkingFolder fallback chain", () => {
  it("prefers the session's own folder over everything", () => {
    const r = resolveWorkingFolder({
      sessionFolder: "C:\\work\\project",
      modeDefault: "C:\\work\\mode-default",
      defaultWorkspace: "C:\\Users\\me\\Documents\\Kozum",
    });
    assert.equal(r.folder, "C:\\work\\project");
    assert.equal(r.isWorkspaceFallback, false);
  });

  it("uses the mode default when no session folder is set", () => {
    const r = resolveWorkingFolder({
      sessionFolder: null,
      modeDefault: "C:\\work\\cowork-default",
      defaultWorkspace: "C:\\Users\\me\\Documents\\Kozum",
    });
    assert.equal(r.folder, "C:\\work\\cowork-default");
    assert.equal(r.isWorkspaceFallback, false);
  });

  it("falls back to the shared default workspace last", () => {
    const workspace = "C:\\Users\\me\\Documents\\Kozum";
    for (const mode of ["cowork", "code"] as const) {
      const r = resolveWorkingFolder({
        sessionFolder: null,
        modeDefault: null,
        defaultWorkspace: workspace,
      });
      void mode;
      assert.equal(r.folder, workspace);
      assert.equal(r.isWorkspaceFallback, true);
    }
  });

  it("returns null (inherit process.cwd()) when nothing is configured", () => {
    const r = resolveWorkingFolder({
      sessionFolder: null,
      modeDefault: null,
      defaultWorkspace: null,
    });
    assert.equal(r.folder, null);
    assert.equal(r.isWorkspaceFallback, false);
  });

  it("detaching a mode override lands on the workspace fallback", () => {
    // The renderer's × control clears defaultFolders[mode]; resolution must
    // then land on the default workspace, not cwd.
    const attached = resolveWorkingFolder({
      sessionFolder: null,
      modeDefault: "C:\\attached",
      defaultWorkspace: "C:\\workspace",
    });
    const detached = resolveWorkingFolder({
      sessionFolder: null,
      modeDefault: null,
      defaultWorkspace: "C:\\workspace",
    });
    assert.equal(attached.folder, "C:\\attached");
    assert.equal(detached.folder, "C:\\workspace");
    assert.equal(detached.isWorkspaceFallback, true);
  });
});

describe("lazy workspace creation", () => {
  it("creates the directory only via the injected mkdir (first use)", async () => {
    const created: string[] = [];
    await ensureWorkspaceDir("C:\\ws\\Kozum", async (path) => {
      created.push(path);
      return undefined;
    });
    assert.deepEqual(created, ["C:\\ws\\Kozum"]);
  });
});
