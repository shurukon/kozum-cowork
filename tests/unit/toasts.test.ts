/**
 * Unit tests for the toast reducer.
 *
 * Tests the pure toastReducer and TOAST_MAX_VISIBLE constant in isolation —
 * no React, no DOM needed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  toastReducer,
  TOAST_MAX_VISIBLE,
  type ToastState,
  type ToastAction,
} from "../../src/renderer/hooks/toastReducer.ts";

// ── Helpers ───────────────────────────────────────────────────────────────

function emptyState(): ToastState {
  return { toasts: [] };
}

import type { ToastSeverity } from "../../src/renderer/hooks/toastReducer.ts";

function pushAction(
  id: string,
  severity: ToastSeverity,
  message: string,
  createdAt = Date.now(),
): ToastAction {
  return { type: "push", id, severity, message, createdAt };
}

function dismissAction(id: string): ToastAction {
  return { type: "dismiss", id };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("toastReducer — push", () => {
  it("adds a toast to an empty state", () => {
    const state = toastReducer(emptyState(), pushAction("t1", "info", "Hello"));
    assert.equal(state.toasts.length, 1);
    assert.equal(state.toasts[0].id, "t1");
    assert.equal(state.toasts[0].severity, "info");
    assert.equal(state.toasts[0].message, "Hello");
  });

  it("newest toast is at index 0 (top of stack)", () => {
    let state = emptyState();
    state = toastReducer(state, pushAction("t1", "info", "First"));
    state = toastReducer(state, pushAction("t2", "success", "Second"));
    assert.equal(state.toasts[0].id, "t2", "newest should be first");
    assert.equal(state.toasts[1].id, "t1", "older should be second");
  });

  it("supports all four severity values", () => {
    const severities = ["info", "success", "warning", "error"] as const;
    for (const sev of severities) {
      const state = toastReducer(emptyState(), pushAction(`t-${sev}`, sev, `msg ${sev}`));
      assert.equal(state.toasts[0].severity, sev);
    }
  });
});

describe("toastReducer — max visible cap", () => {
  it(`caps at TOAST_MAX_VISIBLE (${TOAST_MAX_VISIBLE})`, () => {
    let state = emptyState();
    for (let i = 0; i < TOAST_MAX_VISIBLE + 3; i++) {
      state = toastReducer(state, pushAction(`t${i}`, "info", `msg ${i}`));
    }
    assert.equal(state.toasts.length, TOAST_MAX_VISIBLE);
  });

  it("drops the oldest entries when the cap is exceeded (keeps newest)", () => {
    let state = emptyState();
    for (let i = 0; i < TOAST_MAX_VISIBLE + 2; i++) {
      state = toastReducer(state, pushAction(`t${i}`, "info", `msg ${i}`, i));
    }
    // The newest pushed id is the one at the top
    const newestId = `t${TOAST_MAX_VISIBLE + 1}`;
    assert.equal(state.toasts[0].id, newestId, "newest should be at index 0");
    // The two oldest (t0, t1) should have been evicted
    const ids = state.toasts.map((t) => t.id);
    assert.ok(!ids.includes("t0"), "t0 (oldest) should have been dropped");
    assert.ok(!ids.includes("t1"), "t1 should have been dropped");
  });
});

describe("toastReducer — dismiss", () => {
  it("removes a toast by id", () => {
    let state = emptyState();
    state = toastReducer(state, pushAction("t1", "info", "First"));
    state = toastReducer(state, pushAction("t2", "error", "Second"));
    state = toastReducer(state, dismissAction("t1"));
    assert.equal(state.toasts.length, 1);
    assert.equal(state.toasts[0].id, "t2");
  });

  it("is a no-op for an unknown id", () => {
    let state = emptyState();
    state = toastReducer(state, pushAction("t1", "info", "Msg"));
    const after = toastReducer(state, dismissAction("does-not-exist"));
    assert.equal(after.toasts.length, 1);
  });

  it("dismissing from empty state is safe", () => {
    const after = toastReducer(emptyState(), dismissAction("t1"));
    assert.equal(after.toasts.length, 0);
  });
});

describe("toastReducer — error persistence semantics", () => {
  // The reducer itself does not enforce auto-dismiss (that lives in the React
  // component). But we verify that error toasts are stored identically to
  // other severities — they are NOT filtered out by the reducer.
  it("error toasts are stored and not auto-removed by the reducer", () => {
    let state = emptyState();
    state = toastReducer(state, pushAction("err1", "error", "Something broke"));
    assert.equal(state.toasts.length, 1);
    assert.equal(state.toasts[0].severity, "error");
    // Reducer makes no distinction — persistence is the component's job
    assert.equal(state.toasts[0].id, "err1");
  });
});

describe("toastReducer — ordering invariant", () => {
  it("maintains newest-first order after mixed push/dismiss sequence", () => {
    let state = emptyState();
    state = toastReducer(state, pushAction("a", "info", "A", 1));
    state = toastReducer(state, pushAction("b", "success", "B", 2));
    state = toastReducer(state, pushAction("c", "warning", "C", 3));
    // dismiss middle
    state = toastReducer(state, dismissAction("b"));
    assert.deepEqual(
      state.toasts.map((t) => t.id),
      ["c", "a"],
      "newest first ordering must be preserved after dismiss",
    );
  });
});
