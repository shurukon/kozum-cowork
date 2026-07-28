/**
 * Directory tools — create, delete, list directories.
 *
 * All paths flow through resolvePath() from paths.ts.
 */

import { mkdir, rm, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

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

async function listDir(
  dirPath: string,
  recursive: boolean,
  depth = 0,
): Promise<DirEntry[]> {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const result: DirEntry[] = [];
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      result.push({ name: entry.name + "/", type: "dir" });
      if (recursive) {
        const children = await listDir(fullPath, true, depth + 1);
        for (const child of children) {
          result.push({ ...child, name: entry.name + "/" + child.name });
        }
      }
    } else if (entry.isSymbolicLink()) {
      result.push({ name: entry.name, type: "symlink" });
    } else if (entry.isFile()) {
      let size: number | undefined;
      try {
        const s = await stat(fullPath);
        size = s.size;
      } catch {
        // ignore
      }
      result.push({ name: entry.name, type: "file", size });
    } else {
      result.push({ name: entry.name, type: "other" });
    }
  }
  return result;
}

function formatEntry(e: DirEntry): string {
  const marker = e.type === "dir" ? "[dir]" : e.type === "symlink" ? "[lnk]" : e.type === "other" ? "[oth]" : "[fil]";
  if (e.type === "file" && e.size !== undefined) {
    return `${marker} ${e.name} (${e.size} bytes)`;
  }
  return `${marker} ${e.name}`;
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
        "Recursively delete a directory and all its contents. This is a destructive operation " +
        "that cannot be undone — the contents are permanently removed.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path of the directory to delete." },
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
        "directories, [fil] for files (with size in bytes), [lnk] for symlinks. " +
        "Set recursive=true to list all descendants.",
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

      const entries = await listDir(resolved, recursive);

      if (entries.length === 0) {
        const dp = displayPath(resolved, ctx.workingFolder);
        return ok("(empty directory)", {
          summary: `Listed ${dp} (empty)`,
        });
      }

      const lines = entries.map(formatEntry);
      const dp = displayPath(resolved, ctx.workingFolder);
      return ok(lines.join("\n"), {
        summary: `Listed ${dp} (${entries.length} entries)`,
        files: [resolved],
      });
    },
  },
];
