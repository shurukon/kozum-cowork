/**
 * Directory tools — create, delete, list directories.
 *
 * All paths flow through resolvePath() from paths.ts.
 */

import { mkdir, rm, readdir, stat } from "node:fs/promises";
import { join, normalize, sep } from "node:path";

import type { Tool } from "./registry.ts";
import { ok, fail, describeError } from "./registry.ts";
import { resolvePath, displayPath, PathError } from "./paths.ts";

function str(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}

function bool(v: unknown, def = false): boolean {
  if (v === undefined || v === null) return def;
  if (typeof v === "boolean") return v;
  return v === "true" || v === "1" || v === 1;
}

interface DirEntry {
  name: string;
  type: "file" | "dir" | "symlink" | "other";
  size?: number;
}

/** Maximum recursion depth for directory_list (M9). */
const MAX_LIST_DEPTH = 20;
/** Maximum total entries returned by directory_list (M9). */
const MAX_LIST_ENTRIES = 5000;

async function listDir(
  dirPath: string,
  recursive: boolean,
  signal: AbortSignal,
  depth = 0,
  totalSoFar = { count: 0 },
): Promise<{ entries: DirEntry[]; truncated: boolean }> {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return { entries: [], truncated: false };
  }

  const result: DirEntry[] = [];
  let truncated = false;

  for (const entry of entries) {
    if (signal.aborted) break;

    if (totalSoFar.count >= MAX_LIST_ENTRIES) {
      truncated = true;
      break;
    }

    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      result.push({ name: entry.name + "/", type: "dir" });
      totalSoFar.count++;
      if (recursive && depth < MAX_LIST_DEPTH) {
        const child = await listDir(fullPath, true, signal, depth + 1, totalSoFar);
        for (const c of child.entries) {
          if (totalSoFar.count >= MAX_LIST_ENTRIES) { truncated = true; break; }
          result.push({ ...c, name: entry.name + "/" + c.name });
        }
        if (child.truncated) truncated = true;
      }
    } else if (entry.isSymbolicLink()) {
      // H4: list symlinks as [lnk] but do NOT follow them.
      result.push({ name: entry.name, type: "symlink" });
      totalSoFar.count++;
    } else if (entry.isFile()) {
      let size: number | undefined;
      try {
        const s = await stat(fullPath);
        size = s.size;
      } catch {
        // ignore
      }
      result.push({ name: entry.name, type: "file", size });
      totalSoFar.count++;
    } else {
      result.push({ name: entry.name, type: "other" });
      totalSoFar.count++;
    }
  }
  return { entries: result, truncated };
}

function formatEntry(e: DirEntry): string {
  const marker = e.type === "dir" ? "[dir]" : e.type === "symlink" ? "[lnk]" : e.type === "other" ? "[oth]" : "[fil]";
  if (e.type === "file" && e.size !== undefined) {
    return `${marker} ${e.name} (${e.size} bytes)`;
  }
  return `${marker} ${e.name}`;
}

/** True when `path` is a filesystem root (e.g. "/" or "C:\"). */
function isFilesystemRoot(p: string): boolean {
  const n = normalize(p);
  // POSIX root
  if (n === "/") return true;
  // Windows drive root: "C:\" or "C:/"
  if (/^[a-z]:[/\\]?$/i.test(n)) return true;
  return false;
}

export const dirTools: Tool[] = [

  /* -------------------------------------------------------- directory_create */
  {
    definition: {
      name: "directory_create",
      title: "Create Directory",
      description:
        "Create a directory (and any required parent directories). Safe to call even if " +
        "the directory already exists.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path of the directory to create." },
        },
        required: ["path"],
      },
      icon: "folder-plus",
      group: "filesystem",
      modes: ["cowork", "code"],
    },
    async handler(input, ctx) {
      const resolved = await resolvePath(str(input["path"]), {
        workingFolder: ctx.workingFolder,
        forWrite: true,
      }).catch((e: unknown) => { if (e instanceof PathError) return e; throw e; });
      if (resolved instanceof PathError) return fail(resolved.message);

      try {
        await mkdir(resolved, { recursive: true });
      } catch (e) {
        return fail(describeError(e));
      }

      const dp = displayPath(resolved, ctx.workingFolder);
      return ok(`Created directory ${resolved}`, {
        summary: `Created directory ${dp}`,
        files: [resolved],
      });
    },
  },

  /* -------------------------------------------------------- directory_delete */
  {
    definition: {
      name: "directory_delete",
      title: "Delete Directory",
      description:
        "Delete a directory and all its contents. This is a destructive operation " +
        "that cannot be undone — the contents are permanently removed. " +
        "You must pass recursive=true explicitly as a safety guard. " +
        "Refuses to delete the working folder itself or a filesystem root.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path of the directory to delete." },
          recursive: { type: "boolean", description: "Must be true to confirm recursive deletion.", default: false },
        },
        required: ["path"],
      },
      icon: "folder-minus",
      group: "filesystem",
      dangerous: true,
      modes: ["cowork", "code"],
    },
    async handler(input, ctx) {
      const resolved = await resolvePath(str(input["path"]), {
        workingFolder: ctx.workingFolder,
        forWrite: true,
      }).catch((e: unknown) => { if (e instanceof PathError) return e; throw e; });
      if (resolved instanceof PathError) return fail(resolved.message);

      // M10: require recursive:true as an explicit safety guard (mirrors file_delete).
      const recursive = bool(input["recursive"]);
      if (!recursive) {
        return fail(
          `"${displayPath(resolved, ctx.workingFolder)}" is a directory. ` +
            "Set recursive=true to delete it and all its contents.",
        );
      }

      // M10: refuse to delete the working folder or a filesystem root.
      if (isFilesystemRoot(resolved)) {
        return fail(`Refusing to delete filesystem root "${resolved}".`);
      }
      if (ctx.workingFolder) {
        const normResolved = normalize(resolved);
        const normWorking = normalize(ctx.workingFolder);
        if (normResolved === normWorking || normResolved + sep === normWorking || normResolved === normWorking + sep) {
          return fail(
            `Refusing to delete the working folder "${displayPath(resolved, ctx.workingFolder)}".`,
          );
        }
      }

      try {
        await rm(resolved, { recursive: true, force: true });
      } catch (e) {
        return fail(describeError(e));
      }

      const dp = displayPath(resolved, ctx.workingFolder);
      return ok(`Deleted directory ${resolved}`, {
        summary: `Deleted directory ${dp}`,
      });
    },
  },

  /* --------------------------------------------------------- directory_list */
  {
    definition: {
      name: "directory_list",
      title: "List Directory",
      description:
        "List the contents of a directory. Each entry shows a type marker: [dir] for " +
        "directories, [fil] for files (with size in bytes), [lnk] for symlinks (not followed). " +
        "Set recursive=true to list all descendants. " +
        `Maximum depth: ${MAX_LIST_DEPTH} levels. Maximum entries: ${MAX_LIST_ENTRIES} (truncated with a notice if exceeded).`,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory to list." },
          recursive: { type: "boolean", description: "List all descendants recursively. Default false.", default: false },
        },
        required: ["path"],
      },
      icon: "folder-open",
      group: "filesystem",
      modes: ["cowork", "code"],
    },
    async handler(input, ctx) {
      const resolved = await resolvePath(str(input["path"]), {
        workingFolder: ctx.workingFolder,
      }).catch((e: unknown) => { if (e instanceof PathError) return e; throw e; });
      if (resolved instanceof PathError) return fail(resolved.message);

      const recursive = bool(input["recursive"]);

      const { entries, truncated } = await listDir(resolved, recursive, ctx.signal);

      if (entries.length === 0) {
        const dp = displayPath(resolved, ctx.workingFolder);
        return ok("(empty directory)", {
          summary: `Listed ${dp} (empty)`,
        });
      }

      const lines = entries.map(formatEntry);
      if (truncated) {
        lines.push(`\n[Listing truncated at ${MAX_LIST_ENTRIES} entries]`);
      }
      const dp = displayPath(resolved, ctx.workingFolder);
      return ok(lines.join("\n"), {
        summary: `Listed ${dp} (${entries.length} entries${truncated ? ", truncated" : ""})`,
        files: [resolved],
      });
    },
  },
];
