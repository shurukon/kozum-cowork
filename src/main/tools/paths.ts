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
import { homedir } from "node:os";

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
 *
 * UNC / device paths (\\server\share, \\?\...) are rejected before this list
 * is consulted — see the check in resolvePath below.
 */
const FORBIDDEN_WRITE: RegExp[] = [
  // Windows system directories
  /^[a-z]:[\\/]windows([\\/]|$)/i,
  /^[a-z]:[\\/]program files( \(x86\))?([\\/]|$)/i,
  /^[a-z]:[\\/]\$recycle\.bin/i,
  /^[a-z]:[\\/]programdata([\\/]|$)/i,
  // Windows persistence locations
  /start menu[\\/]programs[\\/]startup/i,
  // POSIX system directories
  /^\/(etc|boot|sys|proc|dev)(\/|$)/,
  /^\/usr\/(bin|sbin|lib)(\/|$)/,
  /^\/usr\/local\/bin(\/|$)/,
  /^\/root(\/|$)/,
  // SSH trust stores and shell init files (all platforms)
  /[/\\]\.ssh[/\\]/i,
  /[/\\]\.(bash|zsh|sh)rc$/i,
  /[/\\]\.profile$/i,
  /[/\\]\.bashrc$/i,
  /[/\\]\.zshrc$/i,
];

/**
 * Build the app's own userData forbidden-write patterns at runtime so this
 * module does not need to import Electron. Call sites that know the userData
 * path (e.g. from app.getPath('userData')) should push extra entries here
 * before any resolvePath calls.
 *
 * The home-directory-relative SSH path is always present.
 */
function buildRuntimeForbidden(): RegExp[] {
  try {
    const home = homedir();
    if (home) {
      return [new RegExp(`^${escapeRegex(home)}[/\\\\]\\.ssh([/\\\\]|$)`, "i")];
    }
  } catch {
    // homedir() can throw in stripped environments
  }
  return [];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const RUNTIME_FORBIDDEN: RegExp[] = buildRuntimeForbidden();

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
 *
 * Returns the canonicalised path (symlinks resolved) rather than the raw
 * normalised absolute path, so callers operate on exactly the path that was
 * checked — closing the check-then-use gap.
 */
export async function resolvePath(
  input: string,
  opts: ResolveOptions,
): Promise<string> {
  const raw = String(input ?? "").trim();
  if (!raw) throw new PathError("Path is empty.");

  // Reject NUL bytes outright; they truncate paths in native calls.
  if (raw.includes("\0")) throw new PathError("Path contains a NUL byte.");

  // Reject UNC paths and Windows device paths — libuv preserves them and
  // FORBIDDEN_WRITE regexes anchored on drive letters never match them.
  if (/^\\\\/.test(raw)) {
    throw new PathError(
      `UNC and device paths are not permitted: "${raw.slice(0, 128)}".\n` +
        "Use a drive-letter path instead.",
    );
  }

  const base = opts.workingFolder;
  const abs = isAbsolute(raw) ? normalize(raw) : resolve(base ?? process.cwd(), raw);

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

  const allForbidden = [...FORBIDDEN_WRITE, ...RUNTIME_FORBIDDEN];
  if (opts.forWrite && allForbidden.some((re) => re.test(canonical))) {
    throw new PathError(`Refusing to write to a protected system location: ${canonical}`);
  }

  // Return the canonicalised path so callers operate on the same path that was checked.
  return canonical;
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
  // macOS default filesystems (HFS+, APFS) are case-insensitive; treat like win32.
  if (process.platform === "win32" || process.platform === "darwin") {
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
