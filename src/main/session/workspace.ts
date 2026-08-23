/**
 * Default-workspace resolution.
 *
 * One shared folder backs both modes whenever nothing more specific is
 * selected. The chain is:
 *
 *   session.workingFolder → defaultFolders[mode] → defaultWorkspace → null
 *
 * `null` falls back to process.cwd() at the call sites. The workspace is a
 * machine folder set from Settings; it is changeable but never removable, so
 * the renderer never offers a clear control for it.
 */

/** Injected fs signature so tests can stub directory creation. */
export type MkdirFn = (path: string, opts: { recursive: boolean }) => Promise<unknown>;

export interface WorkspaceResolution {
  /** The resolved working folder, or null to inherit process.cwd(). */
  folder: string | null;
  /** True when the shared default workspace was the winning candidate. */
  isWorkspaceFallback: boolean;
}

export function resolveWorkingFolder(input: {
  sessionFolder: string | null;
  modeDefault: string | null;
  defaultWorkspace: string | null;
}): WorkspaceResolution {
  if (input.sessionFolder) return { folder: input.sessionFolder, isWorkspaceFallback: false };
  if (input.modeDefault) return { folder: input.modeDefault, isWorkspaceFallback: false };
  if (input.defaultWorkspace) {
    return { folder: input.defaultWorkspace, isWorkspaceFallback: true };
  }
  return { folder: null, isWorkspaceFallback: false };
}

/**
 * Create the default workspace lazily on first use. Best-effort at the call
 * site — a read-only Documents redirect must not fail the whole turn.
 */
export async function ensureWorkspaceDir(folder: string, mkdir: MkdirFn): Promise<void> {
  await mkdir(folder, { recursive: true });
}
