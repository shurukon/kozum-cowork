import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ScheduleDialog } from "../../src/renderer/components/ScheduleDialog.tsx";
import { CustomizePage, type CustomizePageProps } from "../../src/renderer/pages/CustomizePage.tsx";
import { installFakeBridge, makeFakeBridge, makeMcpServer, makePlugin, makeScheduledTask } from "./fixtures.ts";

function customizeProps(overrides: Partial<CustomizePageProps> = {}): CustomizePageProps {
  return {
    skills: [],
    connectors: [],
    plugins: [],
    onToggleSkill: vi.fn(),
    onToggleConnector: vi.fn(),
    onTogglePlugin: vi.fn(),
    onRemoveConnector: vi.fn(),
    onRemovePlugin: vi.fn(),
    onAddConnector: vi.fn(async () => ({ ok: true, value: makeMcpServer() })),
    onInstallPlugin: vi.fn(async () => ({ ok: true, value: makePlugin() })),
    onPickPluginZip: vi.fn(async () => "/tmp/plugin.zip"),
    onBack: vi.fn(),
    ...overrides,
  };
}

describe("ScheduleDialog — empty prompt validation", () => {
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    cleanup = installFakeBridge(makeFakeBridge({
      schedule: {
        create: async (task) => ({ ok: true, value: { ...makeScheduledTask(), ...task, id: "new-task" } }),
      },
    }));
  });

  afterEach(() => cleanup?.());

  it("shows a validation error and does not save an empty prompt", async () => {
    const onSave = vi.fn();
    render(<ScheduleDialog prefill={{}} onSave={onSave} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /schedule/i }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/prompt is required/i));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("calls onSave when a valid prompt is entered", async () => {
    const onSave = vi.fn();
    render(<ScheduleDialog prefill={{}} onSave={onSave} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/scheduled\.prompt/i), { target: { value: "Do the daily standup report." } });
    fireEvent.click(screen.getByRole("button", { name: /schedule/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
  });
});

describe("Customize inline MCP form", () => {
  it("rejects an invalid URL without calling the backend callback", async () => {
    const onAddConnector = vi.fn(async () => ({ ok: true, value: makeMcpServer() }));
    render(<CustomizePage {...customizeProps({ onAddConnector })} initialTab="mcp" />);
    fireEvent.click(screen.getByRole("button", { name: /add server/i }));
    fireEvent.change(screen.getByPlaceholderText(/https:\/\/example\.com\/mcp/i), { target: { value: "ftp://example.com/mcp" } });
    fireEvent.click(screen.getByRole("button", { name: /connect server/i }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/http|url|valid/i));
    expect(onAddConnector).not.toHaveBeenCalled();
  });

  it("passes a valid MCP payload to the backend callback and renders success inline", async () => {
    const onAddConnector = vi.fn(async () => ({ ok: true, value: makeMcpServer({ name: "Docs MCP", toolCount: 3 }) }));
    render(<CustomizePage {...customizeProps({ onAddConnector })} initialTab="mcp" />);
    fireEvent.click(screen.getByRole("button", { name: /add server/i }));
    fireEvent.change(screen.getByPlaceholderText(/https:\/\/example\.com\/mcp/i), { target: { value: "https://my-server.example.com/mcp" } });
    fireEvent.click(screen.getByRole("button", { name: /connect server/i }));
    await waitFor(() => expect(onAddConnector).toHaveBeenCalled());
    expect(onAddConnector.mock.calls[0][0]).toMatchObject({ transport: "http", url: "https://my-server.example.com/mcp", enabled: true, installedByAgent: false });
    expect(await screen.findByText(/connected to docs mcp/i)).toBeInTheDocument();
  });
});

describe("Customize inline Plugin form", () => {
  it("keeps plugin installation disabled until a source is selected", () => {
    render(<CustomizePage {...customizeProps()} initialTab="plugins" />);
    fireEvent.click(screen.getByRole("button", { name: /install plugin/i }));
    expect(screen.getByRole("button", { name: /install plugin/i })).toBeDisabled();
  });

  it("supports GitHub installation through the backend callback", async () => {
    const onInstallPlugin = vi.fn(async () => ({ ok: true, value: makePlugin({ name: "GitHub Plugin" }) }));
    render(<CustomizePage {...customizeProps({ onInstallPlugin })} initialTab="plugins" />);
    fireEvent.click(screen.getByRole("button", { name: /install plugin/i }));
    fireEvent.click(screen.getByRole("tab", { name: /from github/i }));
    fireEvent.change(screen.getByPlaceholderText(/owner\/repo/i), { target: { value: "kozum/my-plugin" } });
    fireEvent.click(screen.getByRole("button", { name: /install plugin/i }));
    await waitFor(() => expect(onInstallPlugin).toHaveBeenCalledWith({ kind: "github", value: "kozum/my-plugin" }));
    expect(await screen.findByText("GitHub Plugin")).toBeInTheDocument();
  });

  it("supports local zip selection through the picker callback", async () => {
    const onInstallPlugin = vi.fn(async () => ({ ok: true, value: makePlugin({ name: "Local Plugin" }) }));
    render(<CustomizePage {...customizeProps({ onInstallPlugin })} initialTab="plugins" />);
    fireEvent.click(screen.getByRole("button", { name: /install plugin/i }));
    fireEvent.click(screen.getByRole("button", { name: /choose a \.zip file/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /install plugin/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: /install plugin/i }));
    await waitFor(() => expect(onInstallPlugin).toHaveBeenCalledWith({ kind: "zip", value: "/tmp/plugin.zip" }));
  });
});
