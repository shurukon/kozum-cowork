/**
 * interaction.test.tsx
 *
 * The most important tests in this project: the composer actually calls the
 * backend when the user types and presses Enter. These target ComposerBar
 * directly — the shared composer both homes now embed (HomeView delegates to it
 * via `composerSlot`), so this covers the canonical send path for both modes.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ComposerBar } from "../../src/renderer/components/ComposerBar.tsx";
import type { ModelSelection } from "../../src/shared/types.ts";

const SELECTION: ModelSelection = {
  providerId: "anthropic",
  keyId: "key-1",
  modelId: "claude-opus-4-5",
};

function renderComposer(onSend = vi.fn()) {
  render(
    <ComposerBar
      busy={false}
      onSend={onSend}
      onCancel={vi.fn()}
      onAttach={vi.fn()}
      selection={SELECTION}
      presets={[]}
      keysByProvider={{}}
      modelsByProvider={{}}
      onSelectionChange={vi.fn()}
      onRefreshModels={async () => {}}
    />,
  );
  return onSend;
}

describe("ComposerBar — Enter sends, Shift+Enter does not", () => {
  it("calls onSend with the typed text when Enter is pressed", () => {
    const onSend = renderComposer();
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "Hello, agent!" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    expect(onSend).toHaveBeenCalledOnce();
    expect(onSend).toHaveBeenCalledWith("Hello, agent!");
  });

  it("does NOT call onSend when Shift+Enter is pressed", () => {
    const onSend = renderComposer();
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "Line one" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("does NOT call onSend when the input is empty and Enter is pressed", () => {
    const onSend = renderComposer();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", shiftKey: false });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("does NOT call onSend when the input is only whitespace", () => {
    const onSend = renderComposer();
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "   " } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("clears the textarea after sending", () => {
    renderComposer();
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Send this" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    expect(textarea.value).toBe("");
  });

  it("does not send while composing an IME sequence", () => {
    const onSend = renderComposer();
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "こんにちは" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false, isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
  });
});

// ── Full App integration: sessions.send is actually called ──────────────
// This test mounts the full App and verifies the actual bridge call path
// from typing in the composer to sessions.send being called.

import { App } from "../../src/renderer/App.tsx";
import {
  makeFakeBridge,
  makeConfiguredSettings,
  installFakeBridge,
  FAKE_PRESETS,
} from "./fixtures.ts";

describe("App — sessions.send is called when user types and presses Enter", () => {
  let sendCalls: Array<{ sid: string; text: string }>;
  let cleanup: () => void;

  beforeEach(() => {
    sendCalls = [];
    const bridge = makeFakeBridge({
      settings: {
        get: async () => makeConfiguredSettings(),
      },
      providers: {
        presets: async () => FAKE_PRESETS,
        listKeys: async (pid) =>
          pid === "anthropic"
            ? [{ id: "key-1", providerId: "anthropic", label: "Personal", maskedKey: "sk-ant-…", createdAt: Date.now(), status: "valid" as const }]
            : [],
      },
      sessions: {
        list: async () => [],
        create: async () => ({
          ok: true,
          value: {
            id: "sess-1",
            mode: "cowork",
            title: "Test session",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            status: "idle" as const,
            workingFolder: null,
            projectId: null,
            selection: { providerId: "anthropic", keyId: "key-1", modelId: "claude-opus-4-5" },
            messageCount: 0,
            totalUsage: { inputTokens: 0, outputTokens: 0 },
            archived: false,
            permissionMode: "accept_edits" as const,
          },
        }),
        send: async (sid: string, text: string) => {
          sendCalls.push({ sid, text });
          return { ok: true as const, value: undefined };
        },
        cancel: async () => ({ ok: true as const, value: undefined }),
        get: async () => null,
        archive: async () => ({ ok: true as const, value: undefined }),
        messages: async () => [],
        reply: async () => ({ ok: true as const, value: undefined }),
        tasks: async () => [],
        onEvent: () => () => {},
      },
    });
    cleanup = installFakeBridge(bridge);
  });

  afterEach(() => {
    cleanup();
  });

  it("sessions.send receives the typed text when Enter is pressed in the home composer", async () => {
    render(<App />);

    // Wait for the app to finish bootstrapping (async settings + presets load).
    await waitFor(
      () => {
        const textarea = screen.queryByRole("textbox", { name: /message/i });
        return textarea !== null;
      },
      { timeout: 3000 },
    );

    const textarea = screen.getByRole("textbox", { name: /message/i });
    fireEvent.change(textarea, { target: { value: "Write a haiku about testing" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    await waitFor(
      () => {
        expect(sendCalls.length).toBeGreaterThan(0);
      },
      { timeout: 3000 },
    );

    expect(sendCalls[0]!.text).toBe("Write a haiku about testing");
  });

  it("sessions.send is NOT called when Shift+Enter is pressed", async () => {
    render(<App />);

    await waitFor(
      () => {
        const textarea = screen.queryByRole("textbox", { name: /message/i });
        return textarea !== null;
      },
      { timeout: 3000 },
    );

    const textarea = screen.getByRole("textbox", { name: /message/i });
    fireEvent.change(textarea, { target: { value: "Line one" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

    // Allow time for any async side effect.
    await new Promise((r) => setTimeout(r, 200));
    expect(sendCalls).toHaveLength(0);
  });
});
