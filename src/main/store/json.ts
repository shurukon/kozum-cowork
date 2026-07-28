/**
 * Atomic JSON read/write helpers.
 *
 * Writes are atomic: data is serialised to a temp file, then renamed over the
 * target. A crash mid-write cannot produce a corrupt or truncated JSON file.
 * Creates parent directories as needed.
 */

import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Read a JSON file, returning `fallback` when the file does not exist or
 * cannot be parsed. All other I/O errors propagate so the caller sees them.
 */
export async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  let text: string;
  try {
    text = await readFile(filePath, "utf-8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return fallback;
    throw e;
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/**
 * Write `value` to `filePath` atomically.
 *
 * 1. Serialise to JSON (throws if the value cannot be serialised).
 * 2. Write to `filePath + ".tmp"`.
 * 3. Rename `.tmp` → target (atomic on all major filesystems).
 *
 * Creates parent directories if they do not exist.
 */
export async function writeJson(filePath: string, value: unknown): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });

  // Step 1: serialise first so that a stringify failure cannot leave a corrupt
  // or empty .tmp file lying around.
  const text = JSON.stringify(value, null, 2);

  // Use a random suffix so two concurrent writes to the same target cannot
  // interleave on the same .tmp file and corrupt each other.
  const suffix = randomBytes(6).toString("hex");
  const tmp = `${filePath}.${suffix}.tmp`;

  // mode 0o600 so the file is readable only by the owning user — important
  // for keys.json and other credential stores.
  await writeFile(tmp, text, { encoding: "utf-8", mode: 0o600 });

  try {
    await rename(tmp, filePath);
  } catch {
    // Clean up the temp file if the rename failed.
    await unlink(tmp).catch(() => undefined);
    throw new Error(`Failed to atomically write ${filePath}`);
  }
}
