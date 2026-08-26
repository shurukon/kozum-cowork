/**
 * Session working-folder discovery (W4).
 *
 * After write-shaped tool calls and at turn end, the session manager scans the
 * session's working folder so newly created artifacts can surface in the UI
 * (context chips + preview Canvas) without the agent having to announce them.
 *
 * Bounded by design: depth ≤ 3, ≤ 200 entries, node_modules/.git/dot-dirs and
 * common heavyweight caches are skipped. Pure fs — no Electron imports — so it
 * is unit-testable.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SessionFileInfo } from "../../shared/types.ts";
import { previewKindForPath } from "../../renderer/lib/previewKind.ts";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  ".kozum",
  "__pycache__",
  ".venv",
  "venv",
  "dist",
  "build",
  ".next",
  ".cache",
]);

const MAX_DEPTH = 3;
const MAX_FILES = 200;

async function walk(dir: string, depth: number, out: SessionFileInfo[]): Promise<void> {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable — skip silently
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      await walk(full, depth + 1, out);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const st = await stat(full);
      out.push({
        path: full,
        name: entry.name,
        kind: previewKindForPath(entry.name),
        size: st.size,
        mtimeMs: st.mtimeMs,
      });
    } catch {
      /* raced deletion — skip */
    }
  }
}

/** Newest-first snapshot of user-facing files in the folder. */
export async function scanSessionFiles(folder: string | null | undefined): Promise<SessionFileInfo[]> {
  if (!folder) return [];
  const files: SessionFileInfo[] = [];
  await walk(folder, 0, files);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files.slice(0, MAX_FILES);
}
