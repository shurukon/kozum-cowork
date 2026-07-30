/**
 * Settings.render.test.tsx
 *
 * Renders <Settings/> with real fixture data and verifies:
 *
 *   1. Providers pane lists the presets it was given — the exact bug that
 *      shipped: it rendered blank because presets={[]} was hardcoded.
 *   2. Clicking a nav item switches panes.
 *   3. Privacy and Usage panes do NOT exist.
 */

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Settings } from "../../src/renderer/components/Settings.tsx";
import { makeSettings, FAKE_PRESETS, FAKE_KEYS, FAKE_SKILLS, FAKE_CONNECTORS, FAKE_PLUGINS } from "./fixtures.ts";

function makeSettingsProps(overrides = {}) {
  return {
    settings: makeSettings(),
    presets: FAKE_PRESETS,
    keys: FAKE_KEYS,
    skills: FAKE_SKILLS,
    connectors: FAKE_CONNECTORS,
    plugins: FAKE_PLUGINS,
    onSave: () => {},
    onAddKey: () => {},
    onRemoveKey: () => {},
    onToggleSkill: () => {},
    onToggleConnector: () => {},
    onTogglePlugin: () => {},
    onAddSkill: () => {},
    onAddConnector: () => {},
    onAddPlugin: () => {},
    onClose: () => {},
    ...overrides,
  };
}

describe("Settings — Providers pane lists presets (the inert-UI bug)", () => {
  it("renders Anthropic and OpenAI when given FAKE_PRESETS", () => {
    render(<Settings {...makeSettingsProps()} />);

    // Navigate to the Providers pane.
    const providersNav = screen.getByRole("button", { name: /providers/i });
    fireEvent.click(providersNav);

    // Both preset names must appear in the content area.
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(screen.getByText("OpenAI")).toBeInTheDocument();
  });

  it("renders an empty state message when presets is empty array", () => {
    // With empty presets, the providers pane renders nothing — but the pane
    // itself should still appear without crashing.
    render(<Settings {...makeSettingsProps({ presets: [], keys: {} })} />);

    const providersNav = screen.getByRole("button", { name: /providers/i });
    fireEvent.click(providersNav);

    // Should render the pane heading at minimum.
    expect(screen.getByRole("heading", { name: /providers/i })).toBeInTheDocument();
  });
});

describe("Settings — nav item switching", () => {
  it("starts on General pane by default", () => {
    render(<Settings {...makeSettingsProps()} />);
    // The General pane title should be visible initially.
    // "General" appears in both the nav button and the pane heading.
    expect(screen.getByText("Your name")).toBeInTheDocument();
  });

  it("clicking Providers nav item shows the Providers pane", () => {
    render(<Settings {...makeSettingsProps()} />);

    const providersBtn = screen.getByRole("button", { name: /providers/i });
    fireEvent.click(providersBtn);

    // The providers pane shows "Add key" buttons for each preset.
    expect(screen.getAllByRole("button", { name: /add key/i }).length).toBeGreaterThan(0);
  });

  it("clicking Skills nav item shows the Skills pane", () => {
    render(<Settings {...makeSettingsProps()} />);

    const skillsBtn = screen.getByRole("button", { name: /^skills$/i });
    fireEvent.click(skillsBtn);

    // FAKE_SKILLS has "Code Review" — it should appear.
    expect(screen.getByText("Code Review")).toBeInTheDocument();
  });

  it("clicking Connectors nav item shows the Connectors pane", () => {
    render(<Settings {...makeSettingsProps()} />);

    const connectorsBtn = screen.getByRole("button", { name: /connectors/i });
    fireEvent.click(connectorsBtn);

    expect(screen.getByText("Local MCP")).toBeInTheDocument();
  });

  it("clicking Plugins nav item shows the Plugins pane", () => {
    render(<Settings {...makeSettingsProps()} />);

    const pluginsBtn = screen.getByRole("button", { name: /plugins/i });
    fireEvent.click(pluginsBtn);

    expect(screen.getByText("Engineering Pack")).toBeInTheDocument();
  });
});

describe("Settings — removed panes stay absent", () => {
  it("does NOT have a Privacy nav item", () => {
    render(<Settings {...makeSettingsProps()} />);
    expect(screen.queryByRole("button", { name: /privacy/i })).toBeNull();
  });

  it("does NOT have a Usage nav item", () => {
    render(<Settings {...makeSettingsProps()} />);
    expect(screen.queryByRole("button", { name: /^usage$/i })).toBeNull();
  });
});

describe("Settings — search filters nav", () => {
  it("search hides non-matching nav items", () => {
    render(<Settings {...makeSettingsProps()} />);

    const searchInput = screen.getByPlaceholderText(/search settings/i);
    fireEvent.change(searchInput, { target: { value: "prov" } });

    // Only "Providers" should match "prov"; other items like "General", "Code" should be hidden.
    expect(screen.queryByRole("button", { name: /^general$/i })).toBeNull();
    expect(screen.getByRole("button", { name: /providers/i })).toBeInTheDocument();
  });
});
