/**
 * App.render.test.tsx
 *
 * Renders <App/> against a fake window.kozum bridge and asserts the three
 * critical startup scenarios:
 *
 *   1. Unconfigured settings  → FirstRun screen appears.
 *   2. Configured settings    → Home screen appears (no FirstRun).
 *   3. Bridge absent          → Error surfaced (not a blank/silent screen).
 *
 * The bridge is a real object with real async functions; no mocking library
 * is used. All assertions are on what the user actually sees.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { App } from "../../src/renderer/App.tsx";
import {
  makeFakeBridge,
  makeSettings,
  makeConfiguredSettings,
  installFakeBridge,
  FAKE_PRESETS,
} from "./fixtures.ts";

describe("App render — bridge absent", () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>)["kozum"];
  });

  it("surfaces an error rather than rendering a blank screen when window.kozum is missing", async () => {
    // Do NOT install a bridge — window.kozum is undefined.
    delete (window as unknown as Record<string, unknown>)["kozum"];

    render(<App />);

    // The App.tsx bootstrap catches the missing bridge and calls setBanner,
    // which pushes an error toast. The toast region renders with role="alert".
    await waitFor(
      () => {
        const alerts = screen.queryAllByRole("alert");
        const hasError = alerts.some((el) =>
          el.textContent?.toLowerCase().includes("backend") ||
          el.textContent?.toLowerCase().includes("window.kozum") ||
          el.textContent?.toLowerCase().includes("not defined"),
        );
        expect(hasError).toBe(true);
      },
      { timeout: 3000 },
    );
  });
});

describe("App render — unconfigured bridge (no provider)", () => {
  let cleanup: () => void;

  beforeEach(() => {
    // Settings with empty providerId/modelId → needsSetup = true
    const bridge = makeFakeBridge({
      settings: {
        get: async () => makeSettings(), // no providerId configured
      },
      providers: {
        presets: async () => FAKE_PRESETS,
        listKeys: async () => [],
      },
    });
    cleanup = installFakeBridge(bridge);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders without throwing", async () => {
    // If render throws, vitest will surface the error as a test failure.
    render(<App />);
    // Wait for the async bootstrap to settle.
    await waitFor(() => {
      // Some element should be in the DOM (not an empty tree).
      expect(document.body.firstChild).not.toBeNull();
    });
  });

  it("shows the FirstRun screen when no provider is configured", async () => {
    render(<App />);

    // FirstRun renders when settings.cowork.selection.providerId is empty and
    // the user has not yet skipped setup. Look for its heading text.
    await waitFor(
      () => {
        // FirstRun.tsx renders a heading mentioning "provider", "connect",
        // or "get started". We check the presence of the component's text.
        const body = document.body.textContent ?? "";
        const hasFirstRunIndicator =
          body.includes("Connect") ||
          body.includes("provider") ||
          body.includes("Get started") ||
          body.includes("Skip") ||
          // The presets list should appear in FirstRun
          body.includes("Anthropic") ||
          body.includes("OpenAI");
        expect(hasFirstRunIndicator).toBe(true);
      },
      { timeout: 3000 },
    );
  });
});

describe("App render — saved key with stale selection", () => {
  let cleanup: () => void;
  let refreshCalls = 0;

  beforeEach(() => {
    refreshCalls = 0;
    const bridge = makeFakeBridge({
      settings: {
        get: async () => makeSettings(),
        set: async (patch) => makeSettings(patch),
      },
      providers: {
        presets: async () => FAKE_PRESETS,
        listKeys: async (pid) => (pid === "anthropic" ? [
          {
            id: "saved-key",
            providerId: "anthropic",
            label: "Saved",
            maskedKey: "sk-ant-…saved",
            createdAt: Date.now(),
            status: "valid",
          },
        ] : []),
        // Simulate a real restart with no cached model catalogue. The
        // bootstrap resolver must refresh using the saved key instead of
        // treating the provider as unconfigured.
        listModels: async () => [],
        refreshModels: async (pid) => {
          if (pid !== "anthropic") return { ok: true, value: [] };
          refreshCalls += 1;
          return {
            ok: true,
            value: [
              {
                id: "claude-test",
                displayName: "Claude Test",
                providerId: "anthropic",
                capabilities: { vision: "no", tools: true, streaming: true, reasoning: false },
              },
            ],
          };
        },
      },
    });
    cleanup = installFakeBridge(bridge);
  });

  afterEach(() => cleanup());

  it("refreshes missing models and does not show FirstRun when a usable saved key exists", async () => {
    render(<App />);
    await waitFor(() => {
      expect(refreshCalls).toBeGreaterThan(0);
      expect(screen.queryByText(/skip for now/i)).toBeNull();
      expect((document.body.textContent ?? "").length).toBeGreaterThan(10);
    }, { timeout: 3000 });
  });
});

describe("App render — configured bridge (provider set)", () => {
  let cleanup: () => void;

  beforeEach(() => {
    const bridge = makeFakeBridge({
      settings: {
        get: async () => makeConfiguredSettings(),
      },
      providers: {
        presets: async () => FAKE_PRESETS,
        listKeys: async (pid) => {
          if (pid === "anthropic") {
            return [
              {
                id: "key-1",
                providerId: "anthropic",
                label: "Personal",
                maskedKey: "sk-ant-…abc1",
                createdAt: Date.now(),
                status: "valid",
              },
            ];
          }
          return [];
        },
      },
    });
    cleanup = installFakeBridge(bridge);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders without throwing when configured", async () => {
    render(<App />);
    await waitFor(() => {
      expect(document.body.firstChild).not.toBeNull();
    });
  });

  it("does NOT show the FirstRun screen when provider is configured", async () => {
    render(<App />);

    // Wait for bootstrap to settle, then check FirstRun is absent.
    // The home screen shows when configured and not in a session; FirstRun
    // should not appear.
    await waitFor(
      () => {
        // At minimum the TitleBar or Sidebar should be present once loaded.
        const body = document.body.textContent ?? "";
        // The home screen shows a composer and greeting; FirstRun shows a
        // "Skip for now" button. If FirstRun is gone, the skip button is absent.
        // We verify the app loaded some content (not blank).
        expect(body.length).toBeGreaterThan(10);
      },
      { timeout: 3000 },
    );

    // "Skip for now" only appears in FirstRun — must be absent in home mode.
    // (Allow for it not being in the DOM at all.)
    const skipButton = screen.queryByText(/skip for now/i);
    expect(skipButton).toBeNull();
  });
});
