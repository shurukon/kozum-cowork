import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SelectorBar } from "../../src/renderer/components/SelectorBar.tsx";
import type { ApiKeyEntry, ModelInfo, ModelSelection, ProviderPreset } from "@shared/types.ts";

const preset: ProviderPreset = {
  id: "kilo",
  name: "Kilo Gateway",
  protocol: "openai-chat",
  baseUrl: "https://api.kilo.ai/api/gateway",
  authScheme: "bearer",
  modelsPath: "/models",
  staticModels: ["kilo/auto-free"],
  builtIn: true,
};

const model: ModelInfo = {
  id: "kilo/auto-free",
  displayName: "Kilo Auto Free",
  providerId: "kilo",
  capabilities: { vision: "no", tools: true, streaming: true, reasoning: false },
};

const selection: ModelSelection = {
  providerId: "kilo",
  keyId: "kilo-key",
  modelId: "kilo/auto-free",
};

function key(id: string, maskedKey: string, status: ApiKeyEntry["status"] = "valid"): ApiKeyEntry {
  return {
    id,
    providerId: "kilo",
    label: id,
    maskedKey,
    createdAt: Date.now(),
    status,
  };
}

describe("SelectorBar — persistent API key indicator", () => {
  it("shows the saved API key beside provider and model even with one key", () => {
    render(
      <SelectorBar
        selection={selection}
        presets={[preset]}
        keysByProvider={{ kilo: [key("kilo-key", "kil_…1234")] }}
        modelsByProvider={{ kilo: [model] }}
        onChange={() => {}}
        onRefreshModels={async () => {}}
      />,
    );

    expect(screen.getByRole("button", { name: /provider: kilo gateway/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /api key: kil_…1234/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /model: kilo auto free/i })).toBeTruthy();
    expect(screen.getByLabelText("API key status: valid")).toBeTruthy();
    expect(screen.getByRole("button", { name: /api key: kil_…1234/i })).toBeDisabled();
  });

  it("keeps the API key control interactive when multiple saved keys exist", () => {
    render(
      <SelectorBar
        selection={selection}
        presets={[preset]}
        keysByProvider={{
          kilo: [key("kilo-key", "kil_…1234"), key("second-key", "kil_…5678")],
        }}
        modelsByProvider={{ kilo: [model] }}
        onChange={() => {}}
        onRefreshModels={async () => {}}
      />,
    );

    const button = screen.getByRole("button", { name: /api key: kil_…1234/i });
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute("aria-haspopup", "listbox");
  });
});
