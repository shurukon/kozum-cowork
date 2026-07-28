/**
 * Kozum Cowork — app data path helpers.
 *
 * Base: join(app.getPath("appData"), "Kozum").
 * Tolerates symlinks/junctions (OneDrive folder redirection).
 * All returned paths are strings; callers create dirs as needed.
 */

import { join } from "node:path";

/** Inject interface so tests can pass a fake instead of real Electron app. */
export interface AppPaths {
  getPath(name: "appData"): string;
}

function base(app: AppPaths): string {
  // getPath returns whatever the OS says, which may be a junction/symlink on
  // Windows with OneDrive redirection. We do NOT resolve symlinks here —
  // that is the deliberate design choice: refusing to traverse them breaks
  // users on affected machines.
  return join(app.getPath("appData"), "Kozum");
}

export function settingsPath(app: AppPaths): string {
  return join(base(app), "settings.json");
}

export function keysPath(app: AppPaths): string {
  return join(base(app), "keys.json");
}

export function sessionsDir(app: AppPaths): string {
  return join(base(app), "sessions");
}

export function memoryDir(app: AppPaths): string {
  return join(base(app), "memory");
}

export function pluginsDir(app: AppPaths): string {
  return join(base(app), "plugins");
}

export function schedulePath(app: AppPaths): string {
  return join(base(app), "schedule.json");
}

export function mcpPath(app: AppPaths): string {
  return join(base(app), "mcp.json");
}

export function modelsDir(app: AppPaths): string {
  return join(base(app), "models");
}

export function modelsFilePath(app: AppPaths, providerId: string): string {
  return join(modelsDir(app), `${providerId}.json`);
}

export function kozumBase(app: AppPaths): string {
  return base(app);
}
