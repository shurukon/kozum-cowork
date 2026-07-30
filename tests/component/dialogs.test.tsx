/**
 * dialogs.test.tsx
 *
 * ScheduleDialog: saving with an EMPTY PROMPT is rejected with a visible
 *   message and schedule.create is NOT called.
 *
 * ConnectorDialog: an invalid URL is rejected client-side.
 *
 * PluginDialog: both zip and GitHub install paths are reachable.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ScheduleDialog } from "../../src/renderer/components/ScheduleDialog.tsx";
import { ConnectorDialog } from "../../src/renderer/components/ConnectorDialog.tsx";
import { PluginDialog } from "../../src/renderer/components/PluginDialog.tsx";
import {
  makeFakeBridge,
  makeScheduledTask,
  makeMcpServer,
  makePlugin,
  installFakeBridge,
} from "./fixtures.ts";

// ── ScheduleDialog ────────────────────────────────────────────────────────

describe("ScheduleDialog — empty prompt validation", () => {
  let scheduleCreateCalled: boolean;
  let cleanup: () => void;

  beforeEach(() => {
    scheduleCreateCalled = false;
    const bridge = makeFakeBridge({
      schedule: {
        create: async (_task) => {
          scheduleCreateCalled = true;
          return { ok: true, value: { ...makeScheduledTask(), id: "new-task", createdAt: Date.now(), runCount: 0, ..._task } };
        },
      },
      dialog: {
        selectFolder: async () => null,
      },
    });
    cleanup = installFakeBridge(bridge);
  });

  afterEach(() => {
    cleanup();
  });

  it("shows a validation error when Schedule is clicked with an empty prompt", async () => {
    render(
      <ScheduleDialog
        prefill={{}}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    // The prompt textarea should be empty by default (no prefill).
    const scheduleBtn = screen.getByRole("button", { name: /schedule/i });
    fireEvent.click(scheduleBtn);

    // A validation error message must appear immediately (no async needed).
    await waitFor(() => {
      const errorEl = screen.queryByRole("alert");
      expect(errorEl).not.toBeNull();
      expect(errorEl?.textContent).toMatch(/prompt is required/i);
    });
  });

  it("does NOT call bridge().schedule.create when prompt is empty", async () => {
    const onSave = vi.fn();
    render(
      <ScheduleDialog
        prefill={{}}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );

    const scheduleBtn = screen.getByRole("button", { name: /schedule/i });
    fireEvent.click(scheduleBtn);

    // Give async code a moment to potentially fire.
    await new Promise((r) => setTimeout(r, 100));

    expect(scheduleCreateCalled).toBe(false);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("calls schedule.create when a valid prompt is entered", async () => {
    const onSave = vi.fn();
    render(
      <ScheduleDialog
        prefill={{}}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );

    const promptTextarea = screen.getByPlaceholderText(/describe what the agent should do/i);
    fireEvent.change(promptTextarea, { target: { value: "Do the daily standup report." } });

    const scheduleBtn = screen.getByRole("button", { name: /schedule/i });
    fireEvent.click(scheduleBtn);

    await waitFor(() => {
      expect(scheduleCreateCalled).toBe(true);
    }, { timeout: 2000 });

    expect(onSave).toHaveBeenCalled();
  });
});

// ── ConnectorDialog ───────────────────────────────────────────────────────

describe("ConnectorDialog — URL validation", () => {
  let cleanup: () => void;

  beforeEach(() => {
    const bridge = makeFakeBridge({
      mcp: {
        add: async (_config) => ({ ok: true, value: makeMcpServer() }),
      },
    });
    cleanup = installFakeBridge(bridge);
  });

  afterEach(() => {
    cleanup();
  });

  it("rejects an invalid URL with a visible error on Save", async () => {
    render(<ConnectorDialog onSave={vi.fn()} onClose={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText(/https:\/\/example\.com\/mcp/i);
    fireEvent.change(urlInput, { target: { value: "not-a-valid-url" } });

    const saveBtn = screen.getByRole("button", { name: "Connect", exact: true });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      const alert = screen.queryByRole("alert");
      expect(alert).not.toBeNull();
      // Should mention URL validation failure.
      expect(alert?.textContent?.toLowerCase()).toMatch(/url|valid|http/);
    });
  });

  it("rejects an ftp:// URL", async () => {
    render(<ConnectorDialog onSave={vi.fn()} onClose={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText(/https:\/\/example\.com\/mcp/i);
    fireEvent.change(urlInput, { target: { value: "ftp://example.com/mcp" } });

    const saveBtn = screen.getByRole("button", { name: "Connect", exact: true });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      const alert = screen.queryByRole("alert");
      expect(alert).not.toBeNull();
    });
  });

  it("accepts a valid https:// URL and calls mcp.add", async () => {
    const onSave = vi.fn();
    render(<ConnectorDialog onSave={onSave} onClose={vi.fn()} />);

    const urlInput = screen.getByPlaceholderText(/https:\/\/example\.com\/mcp/i);
    fireEvent.change(urlInput, { target: { value: "https://my-server.example.com/mcp" } });

    const saveBtn = screen.getByRole("button", { name: "Connect", exact: true });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(onSave).toHaveBeenCalled();
    }, { timeout: 2000 });
  });
});

// ── PluginDialog ──────────────────────────────────────────────────────────

describe("PluginDialog — install paths", () => {
  let cleanup: () => void;

  beforeEach(() => {
    const bridge = makeFakeBridge({
      plugins: {
        installFromUrl: async (url) => ({
          ok: true,
          value: makePlugin({ name: `Plugin from ${url}` }),
        }),
      },
      dialog: {
        selectFiles: async () => ["/tmp/plugin.zip"],
      },
    });
    cleanup = installFakeBridge(bridge);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the zip tab by default", () => {
    render(<PluginDialog onSave={vi.fn()} onClose={vi.fn()} />);

    // The zip tab should be active (aria-selected).
    const zipTab = screen.getByRole("tab", { name: /from \.zip file/i });
    expect(zipTab.getAttribute("aria-selected")).toBe("true");
  });

  it("GitHub tab is reachable by clicking it", () => {
    render(<PluginDialog onSave={vi.fn()} onClose={vi.fn()} />);

    const githubTab = screen.getByRole("tab", { name: /from github/i });
    fireEvent.click(githubTab);

    expect(githubTab.getAttribute("aria-selected")).toBe("true");

    // The GitHub ref input should now be visible.
    expect(screen.getByPlaceholderText(/owner\/repo/i)).toBeInTheDocument();
  });

  it("shows an error if trying to install from GitHub without a ref", async () => {
    render(<PluginDialog onSave={vi.fn()} onClose={vi.fn()} />);

    const githubTab = screen.getByRole("tab", { name: /from github/i });
    fireEvent.click(githubTab);

    const installBtn = screen.getByRole("button", { name: /^install$/i });
    // Button should be disabled when ref is empty.
    expect(installBtn).toBeDisabled();
  });

  it("install button is disabled on zip tab when no file chosen", () => {
    render(<PluginDialog onSave={vi.fn()} onClose={vi.fn()} />);

    const installBtn = screen.getByRole("button", { name: /^install$/i });
    expect(installBtn).toBeDisabled();
  });

  it("install button is enabled after a GitHub ref is entered", () => {
    render(<PluginDialog onSave={vi.fn()} onClose={vi.fn()} />);

    const githubTab = screen.getByRole("tab", { name: /from github/i });
    fireEvent.click(githubTab);

    const refInput = screen.getByPlaceholderText(/owner\/repo/i);
    fireEvent.change(refInput, { target: { value: "kozum/my-plugin" } });

    const installBtn = screen.getByRole("button", { name: /^install$/i });
    expect(installBtn).not.toBeDisabled();
  });

  it("installs a plugin from a GitHub ref and calls onSave", async () => {
    const onSave = vi.fn();
    render(<PluginDialog onSave={onSave} onClose={vi.fn()} />);

    const githubTab = screen.getByRole("tab", { name: /from github/i });
    fireEvent.click(githubTab);

    const refInput = screen.getByPlaceholderText(/owner\/repo/i);
    fireEvent.change(refInput, { target: { value: "kozum/my-plugin" } });

    const installBtn = screen.getByRole("button", { name: /^install$/i });
    fireEvent.click(installBtn);

    await waitFor(() => {
      expect(onSave).toHaveBeenCalled();
    }, { timeout: 2000 });
  });
});
