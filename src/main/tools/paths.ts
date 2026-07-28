/**
 * Path resolution and workspace confinement.
 *
 * Tools receive paths from a language model, which means they receive paths from
 * whatever the model just read — a web page, a repository, an email. Treating
 * those as trusted is how an agent ends up writing to C:\Windows.
 *
 * Confinement rules:
 *   - Relative paths resolve against the session's working folder.
 *   - When a working folder is set, resolved paths must stay inside it.
 *   - Symlinks are resolved *before* the containment check, because a link
 *     inside the folder pointing out of it is otherwise a free escape.
 *   - An unscoped session (no working folder) is allowed anywhere, but still
 *     refuses the OS locations that no agent should ever write to.
 */

import { isAbsolute, normalize, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";

export class PathError extends Error {
  readonly code = "PATH_DENIED";
  constructor(message: string) {
    super(message);
    this.name = "PathError";
  }
}

/**
 * Locations that are never writable, even unscoped. Matched case-insensitively
 * against the resolved path, so drive-letter and slash variance do not matter.
 */
const FORBIDDEN_WRITE = [
  /^[a-z]:[\\/]windows([\\/]|$)/i,
  /^[a-z]:[\\/]program files( \(x86\))?([\\/]|$)/i,
  /^[a-z]:[\\/]\$recycle\.bin/i,
  /^\/(etc|boot|sys|proc|dev)(\/|$)/,
  /^\/usr\/(bin|sbin|lib)(\/|$)/,
];

/** Windows reserved device names; writing to them does surprising things. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export interface ResolveOptions {
  workingFolder: string | null;
  /** Applies the forbidden-location check. Reads are more permissive. */
  forWrite?: boolean;
}

/**
 * Resolve a model-supplied path to an absolute, confined path.
 *
 * `realpath` is attempted first; when the target does not exist yet (the common
 * case for writes) we fall back to resolving its nearest existing ancestor, so
 * a new file inside a symlinked working folder still validates correctly.
 */
export async function resolvePath(
  input: string,
  opts: ResolveOptions,
): Promise<string> {
  const raw = String(input ?? "").trim();
  if (!raw) throw new PathError("Path is empty.");

  // Reject NUL bytes outright; they truncate paths in native calls.
  if (raw.includes("\0")) throw new PathError("Path contains a NUL byte.");

  const base = opts.workingFolder;
  let abs = isAbsolute(raw) ? normalize(raw) : resolve(base ?? process.cwd(), raw);

  const leaf = abs.split(/[\\/]/).pop() ?? "";
  if (RESERVED.test(leaf)) {
    throw new PathError(`"${leaf}" is a reserved Windows device name.`);
  }

  const canonical = await canonicalise(abs);

  if (base) {
    const canonicalBase = await canonicalise(resolve(base));
    if (!contains(canonicalBase, canonical)) {
      throw new PathError(
        `Path escapes the working folder.\n` +
          `  requested: ${raw}\n` +
          `  resolved:  ${canonical}\n` +
          `  folder:    ${canonicalBase}\n` +
          `Ask the user to change the working folder if this is intended.`,
      );
    }
  }

  if (opts.forWrite && FORBIDDEN_WRITE.some((re) => re.test(canonical))) {
    throw new PathError(`Refusing to write to a protected system location: ${canonical}`);
  }

  return abs;
}

/** Resolve symlinks as far as the path exists. */
async function canonicalise(abs: string): Promise<string> {
  try {
    return await realpath(abs);
  } catch {
    // Walk up to the nearest existing ancestor and re-attach the remainder, so
    // a not-yet-created file is still checked against the real parent.
    const parts = abs.split(/[\\/]/);
    const tail: string[] = [];
    while (parts.length > 1) {
      tail.unshift(parts.pop()!);
      const head = parts.join(sep) || sep;
      try {
        const real = await realpath(head);
        return [real, ...tail].join(sep);
      } catch {
        continue;
      }
    }
    return abs;
  }
}

/** True when `child` is `parent` or sits beneath it. */
export function contains(parent: string, child: string): boolean {
  const p = stripTrailing(normalize(parent));
  const c = stripTrailing(normalize(child));
  if (process.platform === "win32") {
    const pl = p.toLowerCase();
    const cl = c.toLowerCase();
    return cl === pl || cl.startsWith(pl + sep.toLowerCase()) || cl.startsWith(pl + "/");
  }
  return c === p || c.startsWith(p + sep);
}

function stripTrailing(p: string): string {
  return p.length > 1 && (p.endsWith(sep) || p.endsWith("/")) ? p.slice(0, -1) : p;
}

/** Shorten a path for display in a transcript card. */
export function displayPath(abs: string, workingFolder: string | null): string {
  if (workingFolder && contains(workingFolder, abs)) {
    const rel = abs.slice(stripTrailing(normalize(workingFolder)).length).replace(/^[\\/]/, "");
    return rel || ".";
  }
  return abs;
}
