/**
 * Kozum Cowork — factory defaults.
 *
 * Kept separate from types.ts so both processes can import the shape without
 * pulling in values, and so "what does a fresh install look like" is answerable
 * by reading one file.
 */

import type { AppSettings, ModeSettings, ModelSelection } from "./types.ts";

/** Nothing is chosen until the user adds a key; the UI prompts for setup. */
const NO_SELECTION: ModelSelection = {
  providerId: "",
  keyId: null,
  modelId: "",
};

/**
 * Cowork leans creative and long-running: a wider output budget and more tool
 * rounds, because document and research work legitimately takes many steps.
 */
const COWORK_DEFAULTS: ModeSettings = {
  selection: { ...NO_SELECTION },
  systemPromptOverride: null,
  maxTokens: 8192,
  temperature: 1,
  maxIterations: 60,
  permissionMode: "manual",
  enabledToolNames: null,
};

/**
 * Code runs longer still and benefits from deterministic output, so temperature
 * drops and the iteration ceiling rises. `accept_edits` matches the reference
 * app's default posture: edits apply, shell commands still ask.
 */
const CODE_DEFAULTS: ModeSettings = {
  selection: { ...NO_SELECTION },
  systemPromptOverride: null,
  maxTokens: 16384,
  temperature: 0,
  maxIterations: 120,
  permissionMode: "accept_edits",
  enabledToolNames: null,
};

export const DEFAULT_SETTINGS: AppSettings = {
  general: {
    userName: "",
    workDescription: "",
    customInstructions: "",
    appearance: "dark",
    chatFont: "sans",
    motion: "system",
    // English is the default UI language. Arabic is available in Settings and
    // flips the shell to RTL; the agent always replies in whatever language the
    // user writes in, independently of this setting.
    language: "en",
  },

  cowork: COWORK_DEFAULTS,
  code: CODE_DEFAULTS,

  computerUse: {
    enabled: false, // opt-in: it can drive the whole desktop
    blocklist: [
      // Credential stores and remote-desktop surfaces are excluded by default.
      // The agent is also instructed never to transact, but defence in depth is
      // cheap here and the failure mode is expensive.
      "mstsc.exe",
      "keepass.exe",
      "keepassxc.exe",
      "1password.exe",
      "bitwarden.exe",
      "dashlane.exe",
    ],
    requireConfirmation: true,
  },

  browser: {
    enabled: true,
    userAgent: null,
    headless: false,
  },

  network: {
    /**
     * These hosts bypass any configured proxy and get retry + mirror fallback.
     * GitHub is here because plugin and marketplace installation depends on it,
     * and a corporate proxy silently breaking it is a support nightmare.
     */
    alwaysAllowHosts: [
      "github.com",
      "api.github.com",
      "raw.githubusercontent.com",
      "codeload.github.com",
      "objects.githubusercontent.com",
    ],
    proxyUrl: null,
    githubFirewallRule: true,
  },

  scheduler: {
    enabled: true,
    keepAwake: true,
  },

  privacy: {
    telemetry: false,
  },
};

/** Deep-clone so callers cannot mutate the frozen factory state. */
export function freshSettings(): AppSettings {
  return structuredClone(DEFAULT_SETTINGS);
}
