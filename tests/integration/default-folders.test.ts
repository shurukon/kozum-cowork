/**
 * Tests for default working folder resolution in AppSettings.
 *
 * The SessionManager resolves working folder as:
 *   session.workingFolder ?? settings.general.defaultFolders[mode] ?? null
 *
 * These tests verify the settings shape and the defaults.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { freshSettings } from "../../src/shared/defaults.ts";

describe("freshSettings — defaultFolders", () => {
  it("has defaultFolders.cowork as null by default", () => {
    const s = freshSettings();
    assert.equal(s.general.defaultFolders.cowork, null);
  });

  it("has defaultFolders.code as null by default", () => {
    const s = freshSettings();
    assert.equal(s.general.defaultFolders.code, null);
  });

  it("has rules as empty string by default", () => {
    const s = freshSettings();
    assert.equal(s.general.rules, "");
  });

  it("has customProviders as empty array by default", () => {
    const s = freshSettings();
    assert.ok(Array.isArray(s.customProviders), "customProviders should be an array");
    assert.equal(s.customProviders.length, 0);
  });

  it("freshSettings returns independent instances (no shared reference)", () => {
    const a = freshSettings();
    const b = freshSettings();
    a.general.defaultFolders.cowork = "/home/user/docs";
    assert.equal(b.general.defaultFolders.cowork, null, "mutation of a should not affect b");
  });
});

describe("default folder fallback logic", () => {
  it("session working folder takes priority over mode default", () => {
    const settings = freshSettings();
    settings.general.defaultFolders.cowork = "/default/cowork";

    // Simulate the resolver from SessionManager
    function resolve(sessionFolder: string | null, mode: "cowork" | "code"): string | null {
      const modeDefault = settings.general.defaultFolders[mode] ?? null;
      return sessionFolder ?? modeDefault;
    }

    assert.equal(resolve("/session/folder", "cowork"), "/session/folder");
    assert.equal(resolve(null, "cowork"), "/default/cowork");
    assert.equal(resolve(null, "code"), null); // code has no default set
  });

  it("a session with no working folder resolves to the configured default", () => {
    const settings = freshSettings();
    settings.general.defaultFolders.code = "/workspace/code";

    function resolve(sessionFolder: string | null, mode: "cowork" | "code"): string | null {
      return sessionFolder ?? (settings.general.defaultFolders[mode] ?? null);
    }

    const result = resolve(null, "code");
    assert.equal(result, "/workspace/code", "should fall back to mode default folder");
  });
});
