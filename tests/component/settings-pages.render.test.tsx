import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SettingsPage } from "../../src/renderer/pages/SettingsPage.tsx";
import { CustomizePage } from "../../src/renderer/pages/CustomizePage.tsx";
import { FAKE_CONNECTORS, FAKE_KEYS, FAKE_PLUGINS, FAKE_PRESETS, FAKE_SKILLS, makeSettings } from "./fixtures.ts";

function settingsProps(overrides: Record<string, unknown> = {}) {
  return {
    settings: makeSettings(),
    presets: FAKE_PRESETS,
    keys: FAKE_KEYS,
    rules: "",
    onRulesChange: vi.fn(),
    onRulesBlur: vi.fn(),
    onSave: vi.fn(),
    onAddKey: vi.fn(),
    onRemoveKey: vi.fn(),
    onAddCustomProvider: vi.fn(async () => undefined),
    onRemoveCustomProvider: vi.fn(),
    onPickFolder: vi.fn(),
    onBack: vi.fn(),
    ...overrides,
  };
}

function customizeProps(overrides: Record<string, unknown> = {}) {
  return {
    skills: FAKE_SKILLS,
    connectors: FAKE_CONNECTORS,
    plugins: FAKE_PLUGINS,
    onToggleSkill: vi.fn(),
    onToggleConnector: vi.fn(),
    onTogglePlugin: vi.fn(),
    onRemoveConnector: vi.fn(),
    onRemovePlugin: vi.fn(),
    onAddConnector: vi.fn(),
    onAddPlugin: vi.fn(),
    onBack: vi.fn(),
    ...overrides,
  };
}

describe("independent settings surfaces", () => {
  it("renders the settings reference sections and real provider catalogue", () => {
    render(<SettingsPage {...settingsProps()} />);
    expect(screen.getByRole("heading", { name: "Profile" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /AI providers/i }));
    expect(screen.getByRole("heading", { name: "AI providers" })).toBeInTheDocument();
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(screen.getByText("OpenAI")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Privacy/i }));
    expect(screen.getByRole("heading", { name: /Privacy/i })).toBeInTheDocument();
  });

  it("persists back navigation through the page callback", () => {
    const onBack = vi.fn();
    render(<SettingsPage {...settingsProps({ onBack })} />);
    fireEvent.click(screen.getByRole("button", { name: /Back to workspace/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("restores Skills and Plugins settings while keeping system and appearance removed", () => {
    const onToggleConnector = vi.fn();
    const onToggleSkill = vi.fn();
    const onTogglePlugin = vi.fn();
    render(<CustomizePage {...customizeProps({ onToggleConnector, onToggleSkill, onTogglePlugin })} />);

    expect(screen.getByRole("heading", { name: "MCP servers" })).toBeInTheDocument();
    expect(screen.getByText("Local MCP")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Enable Local MCP/i }));
    expect(onToggleConnector).toHaveBeenCalledWith("mcp-1", false);

    fireEvent.click(screen.getByRole("button", { name: /^Skills/i }));
    expect(screen.getByRole("heading", { name: "Skills" })).toBeInTheDocument();
    expect(screen.getByText("Code Review")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Enable Code Review/i }));
    expect(onToggleSkill).toHaveBeenCalledWith("skill-1", false);

    fireEvent.click(screen.getByRole("button", { name: /^Plugins/i }));
    expect(screen.getByRole("heading", { name: "Plugins" })).toBeInTheDocument();
    expect(screen.getByText("Engineering Pack")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Enable Engineering Pack/i }));
    expect(onTogglePlugin).toHaveBeenCalledWith("plugin-1", false);

    expect(screen.queryByText("System prompt")).not.toBeInTheDocument();
    expect(screen.queryByText("Colors & fonts")).not.toBeInTheDocument();
  });

  it("shows empty Skills and Plugins settings when nothing is installed", () => {
    render(<CustomizePage {...customizeProps({ skills: [], connectors: [], plugins: [], initialTab: "skills" })} />);

    expect(screen.getByRole("heading", { name: "Skills" })).toBeInTheDocument();
    expect(screen.getByText(/No skills installed yet/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Plugins/i }));
    expect(screen.getByRole("heading", { name: "Plugins" })).toBeInTheDocument();
    expect(screen.getByText(/No plugins installed yet/i)).toBeInTheDocument();
  });
});
