/**
 * Filesystem tools — file-level operations (read, write, edit, move, copy,
 * delete, image read, PDF text extraction, content search, glob matching).
 *
 * All paths flow through resolvePath() from paths.ts before any fs operation.
 */

import {
  readFile,
  writeFile,
  copyFile,
  unlink,
  rm,
  stat,
  mkdir,
  rename,
  readdir,
  realpath,
} from "node:fs/promises";
import { createInflate } from "node:zlib";
import { extname, dirname, join, sep } from "node:path";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

import type { Tool } from "./registry.ts";
import { ok, fail, describeError } from "./registry.ts";
import { resolvePath, displayPath, PathError } from "./paths.ts";

/* ---------------------------------------------------------------- helpers */

function str(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}

function bool(v: unknown, def = false): boolean {
  if (v === undefined || v === null) return def;
  if (typeof v === "boolean") return v;
  return v === "true" || v === "1" || v === 1;
}

function num(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Detect binary by scanning first 8KB for NUL bytes. */
async function isBinary(path: string): Promise<boolean> {
  try {
    const buf = Buffer.alloc(8192);
    const fd = await import("node:fs/promises").then((m) => m.open(path, "r"));
    const { bytesRead } = await fd.read(buf, 0, 8192, 0);
    await fd.close();
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Recursively walk a directory, yielding only regular file paths.
 *
 * Symlinks are skipped entirely — a symlink inside the workspace that points
 * outside it is an arbitrary-read primitive when followed, because only the
 * root directory is checked against the working-folder boundary.
 *
 * @param canonicalBase  The realpath of the workspace root; when provided,
 *   each file's realpath is verified to remain inside before being yielded,
 *   giving defence-in-depth against TOCTOU races.
 */
async function* walkDir(dir: string, canonicalBase?: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      yield* walkDir(full, canonicalBase);
    } else if (entry.isFile()) {
      // Symlinks are intentionally excluded here (H4 fix).
      if (canonicalBase) {
        // Defence-in-depth: verify the file's realpath is still inside the base.
        try {
          const real = await realpath(full);
          if (!real.startsWith(canonicalBase + sep) && real !== canonicalBase) continue;
        } catch {
          continue;
        }
      }
      yield full;
    }
    // isSymbolicLink() falls through — deliberately not yielded.
  }
}

/* ------------------------------------------------------ glob_match helpers */

/** Maximum number of brace-expansion alternatives before we refuse. */
const MAX_BRACE_ALTERNATIVES = 256;
/** Maximum number of nested/sequential brace groups allowed in one pattern. */
const MAX_BRACE_GROUPS = 8;
/** Maximum number of ** wildcard segments in one glob pattern. */
const MAX_DOUBLESTAR_COUNT = 6;
/** Maximum number of single * wildcards in one glob pattern. */
const MAX_STAR_COUNT = 16;

/**
 * Convert a glob pattern into a RegExp.
 * Supports **, *, ?, {a,b,c}, [chars].
 *
 * Throws a RangeError if the pattern would produce more than MAX_BRACE_ALTERNATIVES
 * expansions or contains more than MAX_BRACE_GROUPS brace groups, to prevent
 * exponential blowup from model-controlled inputs (H7).
 */
function globToRegex(pattern: string): RegExp {
  // Count top-level brace groups to enforce MAX_BRACE_GROUPS before recursing.
  let braceGroupCount = 0;
  {
    let d = 0;
    for (const ch of pattern) {
      if (ch === "{") { if (d === 0) braceGroupCount++; d++; }
      else if (ch === "}") d--;
    }
  }
  if (braceGroupCount > MAX_BRACE_GROUPS) {
    throw new RangeError(
      `Glob pattern has ${braceGroupCount} brace groups; maximum is ${MAX_BRACE_GROUPS}. ` +
        "Simplify the pattern.",
    );
  }

  // Expand {a,b} alternatives first.
  function expandBraces(p: string): string[] {
    const start = p.indexOf("{");
    if (start === -1) return [p];
    // find matching }
    let depth = 0;
    let end = -1;
    for (let i = start; i < p.length; i++) {
      if (p[i] === "{") depth++;
      else if (p[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) return [p]; // unmatched, treat literally
    const before = p.slice(0, start);
    const after = p.slice(end + 1);
    const inside = p.slice(start + 1, end);
    // Split by top-level commas
    const alts: string[] = [];
    let cur = "";
    let d = 0;
    for (const ch of inside) {
      if (ch === "{") {
        d++;
        cur += ch;
      } else if (ch === "}") {
        d--;
        cur += ch;
      } else if (ch === "," && d === 0) {
        alts.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    alts.push(cur);
    const results: string[] = [];
    for (const alt of alts) {
      for (const expanded of expandBraces(before + alt + after)) {
        results.push(expanded);
        if (results.length > MAX_BRACE_ALTERNATIVES) {
          throw new RangeError(
            `Glob pattern expands to more than ${MAX_BRACE_ALTERNATIVES} alternatives. ` +
              "Simplify the pattern.",
          );
        }
      }
    }
    return results;
  }

  function singleGlobToRegexSrc(p: string): string {
    // Count ** and * occurrences before building to enforce caps (H7).
    let doubleStarCount = 0;
    let singleStarCount = 0;
    for (let k = 0; k < p.length; k++) {
      if (p[k] === "*") {
        if (p[k + 1] === "*") { doubleStarCount++; k++; }
        else singleStarCount++;
      }
    }
    if (doubleStarCount > MAX_DOUBLESTAR_COUNT) {
      throw new RangeError(
        `Glob pattern has ${doubleStarCount} "**" segments; maximum is ${MAX_DOUBLESTAR_COUNT}. ` +
          "Simplify the pattern.",
      );
    }
    if (singleStarCount > MAX_STAR_COUNT) {
      throw new RangeError(
        `Glob pattern has ${singleStarCount} "*" wildcards; maximum is ${MAX_STAR_COUNT}. ` +
          "Simplify the pattern.",
      );
    }

    let src = "";
    let i = 0;
    while (i < p.length) {
      const ch = p[i]!;
      if (ch === "*") {
        if (p[i + 1] === "*") {
          // ** matches any path segment including slashes.
          // Use [^]* (matches any character including newlines in JS) but
          // the key ReDoS issue is when ** follows ** — we prevent that
          // at the count level above.  The pattern [^\0]* is equivalent
          // to .* but the real protection is the MAX_DOUBLESTAR_COUNT cap.
          src += ".*";
          i += 2;
          // skip optional trailing slash after **
          if (p[i] === "/" || p[i] === sep) i++;
        } else {
          // * matches anything except slash
          src += "[^/\\\\]*";
          i++;
        }
      } else if (ch === "?") {
        src += "[^/\\\\]";
        i++;
      } else if (ch === "[") {
        // Character class — copy through until ]
        const end = p.indexOf("]", i + 1);
        if (end === -1) {
          src += "\\[";
          i++;
        } else {
          src += p.slice(i, end + 1);
          i = end + 1;
        }
      } else if (/[.+^${}()|[\]\\]/.test(ch)) {
        src += "\\" + ch;
        i++;
      } else {
        src += ch;
        i++;
      }
    }
    return src;
  }

  const alts = expandBraces(pattern);
  const src = alts.map(singleGlobToRegexSrc).join("|");
  return new RegExp(`^(?:${src})$`, "i");
}

/** Test whether a path matches a glob pattern. */
function matchGlob(pattern: string, filePath: string): boolean {
  // Normalise separators to forward slash for matching
  const normalised = filePath.replace(/\\/g, "/");
  const re = globToRegex(pattern.replace(/\\/g, "/"));
  return re.test(normalised);
}

/**
 * Compile a glob pattern once and return a test function.
 * Use this in hot loops to avoid recompiling the pattern per file.
 */
function compileGlob(pattern: string): (filePath: string) => boolean {
  const re = globToRegex(pattern.replace(/\\/g, "/"));
  return (filePath: string) => re.test(filePath.replace(/\\/g, "/"));
}

/* ------------------------------------------------------------------ PDF */

/** Maximum page number accepted in the `pages` parameter (M6). */
const MAX_PDF_PAGE = 10000;

/**
 * Validate and parse a PDF page-range string.
 * Returns a Set of 1-based page numbers, or null for "all pages".
 * Throws a RangeError if any value is out of range 1..MAX_PDF_PAGE.
 */
function parsePdfPages(pages: string): Set<number> {
  const wantedPages = new Set<number>();
  for (const part of pages.split(",")) {
    const rangePart = part.trim();
    if (!rangePart) continue;
    const dash = rangePart.indexOf("-");
    if (dash !== -1) {
      const from = parseInt(rangePart.slice(0, dash), 10);
      const to = parseInt(rangePart.slice(dash + 1), 10);
      if (!Number.isFinite(from) || !Number.isFinite(to) || from < 1 || to < from || to > MAX_PDF_PAGE) {
        throw new RangeError(
          `Invalid page range "${rangePart}". Values must be integers between 1 and ${MAX_PDF_PAGE}.`,
        );
      }
      for (let p = from; p <= to; p++) wantedPages.add(p);
    } else {
      const n = parseInt(rangePart, 10);
      if (!Number.isFinite(n) || n < 1 || n > MAX_PDF_PAGE) {
        throw new RangeError(
          `Invalid page "${rangePart}". Values must be integers between 1 and ${MAX_PDF_PAGE}.`,
        );
      }
      wantedPages.add(n);
    }
  }
  return wantedPages;
}

/** Very basic PDF BT/ET text extraction without external deps. */
async function extractPdfText(path: string, pages?: string): Promise<string> {
  const buf = await readFile(path);
  const raw = buf.toString("binary");

  // Parse requested page range — validated to prevent unbounded Set fill (M6).
  let wantedPages: Set<number> | null = null;
  if (pages) {
    wantedPages = parsePdfPages(pages);
  }

  // Find all stream objects with FlateDecode (or no filter for plain streams)
  const streamTexts: string[] = [];
  // Content streams appear in document order, so their index approximates the
  // page number. This is an approximation, not true page segmentation — the
  // tool description says so rather than implying exact page addressing.
  const streamRegex = /<<([^>]*?)>>\s*stream\r?\n/gs;
  let m: RegExpExecArray | null;

  while ((m = streamRegex.exec(raw)) !== null) {
    const dictStr = m[1] ?? "";
    const isFlate = /\/Filter\s*\/FlateDecode/.test(dictStr) ||
      /\/Filter\s*\[.*?\/FlateDecode.*?\]/.test(dictStr);
    const isPlain = !/\/Filter/.test(dictStr);

    if (!isFlate && !isPlain) continue;

    // Extract length
    const lenMatch = /\/Length\s+(\d+)/.exec(dictStr);
    if (!lenMatch) continue;
    const length = parseInt(lenMatch[1]!, 10);

    const streamStart = m.index + m[0].length;
    const streamEnd = streamStart + length;
    if (streamEnd > raw.length) continue;

    const streamBuf = buf.slice(streamStart, streamEnd);

    let text = "";
    if (isFlate) {
      try {
        const decompressed = await new Promise<Buffer>((resolve, reject) => {
          const chunks: Buffer[] = [];
          const inflate = createInflate();
          inflate.on("data", (chunk: Buffer) => chunks.push(chunk));
          inflate.on("end", () => resolve(Buffer.concat(chunks)));
          inflate.on("error", reject);
          inflate.write(streamBuf);
          inflate.end();
        });
        text = decompressed.toString("latin1");
      } catch {
        continue;
      }
    } else {
      text = streamBuf.toString("latin1");
    }

    // Extract text from BT/ET blocks, keeping this stream's text together so a
    // page selection can address it.
    const frag: string[] = [];
    const btBlocks = text.match(/BT[\s\S]*?ET/g) ?? [];
    for (const block of btBlocks) {
      const tjMatches = block.matchAll(/\(([^)]*)\)\s*Tj/g);
      for (const tj of tjMatches) {
        frag.push(decodePdfString(tj[1] ?? ""));
      }
      // TJ: [(text) ...] TJ
      const tjArrMatches = block.matchAll(/\[([^\]]*)\]\s*TJ/g);
      for (const tjArr of tjArrMatches) {
        const inner = tjArr[1] ?? "";
        const parts = inner.matchAll(/\(([^)]*)\)/g);
        for (const part of parts) {
          frag.push(decodePdfString(part[1] ?? ""));
        }
      }
    }
    if (frag.length) streamTexts.push(frag.join(" "));
  }

  // Apply the page selection. Without this the `pages` argument was accepted,
  // validated, and then silently ignored.
  const selected =
    wantedPages === null
      ? streamTexts
      : streamTexts.filter((_t, i) => wantedPages.has(i + 1));

  const combined = selected.join(" ").replace(/\s+/g, " ").trim();
  if (!combined || combined.length < 20) {
    return "";
  }
  return combined;
}

function decodePdfString(s: string): string {
  return s
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\([0-7]{1,3})/g, (_, oct: string) =>
      String.fromCharCode(parseInt(oct, 8)),
    )
    .replace(/\\(.)/g, "$1");
}

/* ============================================================ tool list */

export const fsTools: Tool[] = [

  /* ---------------------------------------------------------------- file_read */
  {
    definition: {
      name: "file_read",
      title: "Read File",
      description:
        "Read the contents of a text file. Returns the file content as a string. " +
        "Use `offset` (integer, may be negative to count from end) to skip to a line, " +
        "`limit` to cap the number of lines returned. " +
        "Files larger than 256 KB are automatically truncated to the first 2000 lines " +
        "unless `limit` is supplied. Files larger than 10 MB are refused outright — " +
        "use offset+limit to page them. " +
        "Use file_read_image for images and file_read_pdf for PDFs.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or working-folder-relative path to the file." },
          encoding: { type: "string", description: "Text encoding, e.g. utf-8 (default), latin1, ascii." },
          offset: { type: "integer", description: "Line offset to start from. Negative counts from end of file." },
          limit: { type: "integer", description: "Maximum number of lines to return." },
        },
        required: ["path"],
      },
      icon: "file-text",
      group: "filesystem",
      modes: ["cowork", "code"],
    },
    async handler(input, ctx) {
      const resolved = await resolvePath(str(input["path"]), {
        workingFolder: ctx.workingFolder,
      }).catch((e: unknown) => {
        if (e instanceof PathError) return e;
        throw e;
      });
      if (resolved instanceof PathError) return fail(resolved.message);

      // M11: stat first — refuse above a hard byte cap.
      const FILE_HARD_CAP = 10 * 1024 * 1024; // 10 MB
      const FILE_DEFAULT_LIMIT_LINES = 2000;
      try {
        const s = await stat(resolved);
        if (s.size > FILE_HARD_CAP) {
          return fail(
            `File is ${(s.size / 1024 / 1024).toFixed(1)} MB, which exceeds the 10 MB read cap. ` +
              "Use offset and limit to read it in pages.",
          );
        }
      } catch (e) {
        return fail(describeError(e));
      }

      let text: string;
      try {
        const enc = str(input["encoding"] || "utf-8") as BufferEncoding;
        text = await readFile(resolved, enc);
      } catch (e) {
        return fail(describeError(e));
      }

      const lines = text.split("\n");
      const rawOffset = num(input["offset"]);
      const rawLimit = num(input["limit"]);

      let start = 0;
      let end = lines.length;

      if (rawOffset !== undefined) {
        start = rawOffset < 0 ? Math.max(0, lines.length + rawOffset) : rawOffset;
      }
      // M11: apply a default limit when the caller did not supply one and the
      // file is larger than 256 KB.
      const defaultLimitBytes = 256 * 1024;
      if (rawLimit !== undefined && rawLimit > 0) {
        end = start + rawLimit;
      } else if (text.length > defaultLimitBytes) {
        end = start + FILE_DEFAULT_LIMIT_LINES;
      }

      const sliced = lines.slice(start, end);
      const content = sliced.join("\n");
      let truncNote = "";
      if (end < lines.length) {
        truncNote = `\n\n[File truncated: showing lines ${start + 1}–${Math.min(end, lines.length)} of ${lines.length}. Use offset and limit to read more.]`;
      }

      const dp = displayPath(resolved, ctx.workingFolder);
      return ok(content + truncNote, {
        summary: `Read ${dp} (${sliced.length} lines)`,
        files: [resolved],
      });
    },
  },

  /* --------------------------------------------------------------- file_write */
  {
    definition: {
      name: "file_write",
      title: "Write File",
      description:
        "Write or append content to a file. Creates parent directories automatically. " +
        "Set append=true to add to the end of an existing file rather than overwriting it.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to write to." },
          content: { type: "string", description: "Content to write." },
          append: { type: "boolean", description: "Append to file instead of overwriting. Default false.", default: false },
        },
        required: ["path", "content"],
      },
      icon: "file-plus",
      group: "filesystem",
      modes: ["cowork", "code"],
    },
    async handler(input, ctx) {
      const resolved = await resolvePath(str(input["path"]), {
        workingFolder: ctx.workingFolder,
        forWrite: true,
      }).catch((e: unknown) => {
        if (e instanceof PathError) return e;
        throw e;
      });
      if (resolved instanceof PathError) return fail(resolved.message);

      const content = str(input["content"]);
      const append = bool(input["append"]);

      try {
        await mkdir(dirname(resolved), { recursive: true });
        if (append) {
          await writeFile(resolved, content, { encoding: "utf-8", flag: "a" });
        } else {
          await writeFile(resolved, content, { encoding: "utf-8" });
        }
      } catch (e) {
        return fail(describeError(e));
      }

      const dp = displayPath(resolved, ctx.workingFolder);
      const verb = append ? "Appended" : "Wrote";
      return ok(`${verb} ${content.length} bytes to ${resolved}`, {
        summary: `${verb} ${dp}`,
        files: [resolved],
      });
    },
  },

  /* ---------------------------------------------------------------- file_edit */
  {
    definition: {
      name: "file_edit",
      title: "Edit File",
      description:
        "Replace the first occurrence (or all occurrences) of `oldString` with `newString` " +
        "in a file. Fails with a clear message if oldString is not found. If oldString appears " +
        "multiple times and replaceAll is false, fails and asks you to disambiguate by adding " +
        "more surrounding context to oldString. Returns a diff in display.diff.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File to edit." },
          oldString: { type: "string", description: "Exact string to find and replace." },
          newString: { type: "string", description: "Replacement string." },
          replaceAll: { type: "boolean", description: "Replace every occurrence. Default false.", default: false },
        },
        required: ["path", "oldString", "newString"],
      },
      icon: "file-edit",
      group: "filesystem",
      modes: ["cowork", "code"],
    },
    async handler(input, ctx) {
      const resolved = await resolvePath(str(input["path"]), {
        workingFolder: ctx.workingFolder,
        forWrite: true,
      }).catch((e: unknown) => {
        if (e instanceof PathError) return e;
        throw e;
      });
      if (resolved instanceof PathError) return fail(resolved.message);

      const oldString = str(input["oldString"]);
      const newString = str(input["newString"]);
      const replaceAll = bool(input["replaceAll"]);

      let before: string;
      try {
        before = await readFile(resolved, "utf-8");
      } catch (e) {
        return fail(describeError(e));
      }

      const count = countOccurrences(before, oldString);
      if (count === 0) {
        return fail(
          `oldString not found in ${displayPath(resolved, ctx.workingFolder)}. ` +
            `The string "${oldString.slice(0, 80)}${oldString.length > 80 ? "…" : ""}" ` +
            `does not appear in the file. Check the exact whitespace and content.`,
        );
      }
      if (count > 1 && !replaceAll) {
        return fail(
          `oldString appears ${count} times in ${displayPath(resolved, ctx.workingFolder)}. ` +
            `To replace all occurrences set replaceAll=true. To replace a specific one, ` +
            `add more surrounding context to oldString so it matches exactly once.`,
        );
      }

      const after = replaceAll
        ? before.split(oldString).join(newString)
        : before.replace(oldString, newString);

      try {
        await writeFile(resolved, after, "utf-8");
      } catch (e) {
        return fail(describeError(e));
      }

      const dp = displayPath(resolved, ctx.workingFolder);
      return ok(`Edited ${resolved}: replaced ${replaceAll ? count : 1} occurrence(s).`, {
        summary: `Edited ${dp}`,
        files: [resolved],
        diff: { path: resolved, before, after },
      });
    },
  },

  /* -------------------------------------------------------- file_edit_enhanced */
  {
    definition: {
      name: "file_edit_enhanced",
      title: "Edit File (Enhanced)",
      description:
        "Like file_edit but adds a dryRun mode. When dryRun=true the file is not " +
        "modified; the response tells you how many replacements would be made. " +
        "Returns replacement count in the content string.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File to edit." },
          oldString: { type: "string", description: "Exact string to find and replace." },
          newString: { type: "string", description: "Replacement string." },
          replaceAll: { type: "boolean", description: "Replace every occurrence. Default false.", default: false },
          dryRun: { type: "boolean", description: "If true, preview without writing. Default false.", default: false },
        },
        required: ["path", "oldString", "newString"],
      },
      icon: "file-search",
      group: "filesystem",
      modes: ["cowork", "code"],
    },
    async handler(input, ctx) {
      const resolved = await resolvePath(str(input["path"]), {
        workingFolder: ctx.workingFolder,
        forWrite: !bool(input["dryRun"]),
      }).catch((e: unknown) => {
        if (e instanceof PathError) return e;
        throw e;
      });
      if (resolved instanceof PathError) return fail(resolved.message);

      const oldString = str(input["oldString"]);
      const newString = str(input["newString"]);
      const replaceAll = bool(input["replaceAll"]);
      const dryRun = bool(input["dryRun"]);

      let before: string;
      try {
        before = await readFile(resolved, "utf-8");
      } catch (e) {
        return fail(describeError(e));
      }

      const count = countOccurrences(before, oldString);
      if (count === 0) {
        return fail(
          `oldString not found in ${displayPath(resolved, ctx.workingFolder)}. ` +
            `The string "${oldString.slice(0, 80)}${oldString.length > 80 ? "…" : ""}" ` +
            `does not appear in the file.`,
        );
      }
      if (count > 1 && !replaceAll) {
        return fail(
          `oldString appears ${count} times in ${displayPath(resolved, ctx.workingFolder)}. ` +
            `Set replaceAll=true or add more context to match exactly once.`,
        );
      }

      const replaceCount = replaceAll ? count : 1;
      const after = replaceAll
        ? before.split(oldString).join(newString)
        : before.replace(oldString, newString);

      if (dryRun) {
        const dp = displayPath(resolved, ctx.workingFolder);
        return ok(
          `DRY RUN: ${replaceCount} replacement(s) would be made in ${resolved}.`,
          {
            summary: `Dry run: ${replaceCount} replacement(s) in ${dp}`,
            files: [resolved],
            diff: { path: resolved, before, after },
          },
        );
      }

      try {
        await writeFile(resolved, after, "utf-8");
      } catch (e) {
        return fail(describeError(e));
      }

      const dp = displayPath(resolved, ctx.workingFolder);
      return ok(`Edited ${resolved}: replaced ${replaceCount} occurrence(s).`, {
        summary: `Edited ${dp} (${replaceCount} replacement(s))`,
        files: [resolved],
        diff: { path: resolved, before, after },
      });
    },
  },

  /* ---------------------------------------------------------------- file_move */
  {
    definition: {
      name: "file_move",
      title: "Move / Rename File",
      description:
        "Move or rename a file or directory. Creates destination parent directories. " +
        "Handles cross-device moves by falling back to copy+delete when rename fails.",
      inputSchema: {
        type: "object",
        properties: {
          source: { type: "string", description: "Path to move from." },
          destination: { type: "string", description: "Path to move to." },
        },
        required: ["source", "destination"],
      },
      icon: "file-symlink",
      group: "filesystem",
      modes: ["cowork", "code"],
    },
    async handler(input, ctx) {
      // H10: moving a file IS a write to the source location — apply forWrite
      // so the protected-location guard runs on the source as well.
      const src = await resolvePath(str(input["source"]), {
        workingFolder: ctx.workingFolder,
        forWrite: true,
      }).catch((e: unknown) => { if (e instanceof PathError) return e; throw e; });
      if (src instanceof PathError) return fail(src.message);

      const dst = await resolvePath(str(input["destination"]), {
        workingFolder: ctx.workingFolder,
        forWrite: true,
      }).catch((e: unknown) => { if (e instanceof PathError) return e; throw e; });
      if (dst instanceof PathError) return fail(dst.message);

      try {
        await mkdir(dirname(dst), { recursive: true });
        await rename(src, dst);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "EXDEV") {
          // Cross-device: copy then unlink
          try {
            await copyFile(src, dst);
            await unlink(src);
          } catch (e2) {
            return fail(describeError(e2));
          }
        } else {
          return fail(describeError(e));
        }
      }

      const dp = displayPath(dst, ctx.workingFolder);
      return ok(`Moved to ${dst}`, {
        summary: `Moved to ${dp}`,
        files: [dst],
      });
    },
  },

  /* ---------------------------------------------------------------- file_copy */
  {
    definition: {
      name: "file_copy",
      title: "Copy File",
      description:
        "Copy a file to a new location. Creates destination parent directories automatically.",
      inputSchema: {
        type: "object",
        properties: {
          source: { type: "string", description: "Path to copy from." },
          destination: { type: "string", description: "Path to copy to." },
        },
        required: ["source", "destination"],
      },
      icon: "copy",
      group: "filesystem",
      modes: ["cowork", "code"],
    },
    async handler(input, ctx) {
      const src = await resolvePath(str(input["source"]), {
        workingFolder: ctx.workingFolder,
      }).catch((e: unknown) => { if (e instanceof PathError) return e; throw e; });
      if (src instanceof PathError) return fail(src.message);

      const dst = await resolvePath(str(input["destination"]), {
        workingFolder: ctx.workingFolder,
        forWrite: true,
      }).catch((e: unknown) => { if (e instanceof PathError) return e; throw e; });
      if (dst instanceof PathError) return fail(dst.message);

      try {
        await mkdir(dirname(dst), { recursive: true });
        await copyFile(src, dst);
      } catch (e) {
        return fail(describeError(e));
      }

      const dp = displayPath(dst, ctx.workingFolder);
      return ok(`Copied to ${dst}`, {
        summary: `Copied to ${dp}`,
        files: [dst],
      });
    },
  },

  /* --------------------------------------------------------------- file_delete */
  {
    definition: {
      name: "file_delete",
      title: "Delete File or Directory",
      description:
        "Delete a file. To delete a directory you must pass recursive=true explicitly " +
        "(this is a safety guard — the tool refuses a directory without it).",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to delete." },
          recursive: { type: "boolean", description: "Required true to delete a directory. Default false.", default: false },
        },
        required: ["path"],
      },
      icon: "trash-2",
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

      const recursive = bool(input["recursive"]);

      try {
        const s = await stat(resolved);
        if (s.isDirectory()) {
          if (!recursive) {
            return fail(
              `"${displayPath(resolved, ctx.workingFolder)}" is a directory. ` +
                `Set recursive=true to delete it and all its contents.`,
            );
          }
          await rm(resolved, { recursive: true, force: true });
        } else {
          await unlink(resolved);
        }
      } catch (e) {
        return fail(describeError(e));
      }

      const dp = displayPath(resolved, ctx.workingFolder);
      return ok(`Deleted ${resolved}`, {
        summary: `Deleted ${dp}`,
      });
    },
  },

  /* ------------------------------------------------------------ file_read_image */
  {
    definition: {
      name: "file_read_image",
      title: "Read Image File",
      description:
        "Read an image file (PNG, JPEG, GIF, WEBP, BMP, SVG) and return it as a base64 " +
        "blob into context. Use this when you need " +
        "to inspect a diagram, screenshot, or photo.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the image file." },
        },
        required: ["path"],
      },
      icon: "image",
      group: "filesystem",
      modes: ["cowork", "code"],
    },
    async handler(input, ctx) {
      const resolved = await resolvePath(str(input["path"]), {
        workingFolder: ctx.workingFolder,
      }).catch((e: unknown) => { if (e instanceof PathError) return e; throw e; });
      if (resolved instanceof PathError) return fail(resolved.message);

      const ext = extname(resolved).toLowerCase().slice(1);
      const mimeMap: Record<string, string> = {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
        bmp: "image/bmp",
        svg: "image/svg+xml",
      };
      const mimeType = mimeMap[ext] ?? "image/png";

      let data: string;
      try {
        const buf = await readFile(resolved);
        data = buf.toString("base64");
      } catch (e) {
        return fail(describeError(e));
      }

      const dp = displayPath(resolved, ctx.workingFolder);
      return ok(`Image loaded: ${dp}`, { summary: `Loaded image ${dp}`, files: [resolved] }, [
        { mimeType, data },
      ]);
    },
  },

  /* ------------------------------------------------------------- file_read_pdf */
  {
    definition: {
      name: "file_read_pdf",
      title: "Read PDF",
      description:
        "Extract text from a PDF file by parsing FlateDecode streams and BT/ET text " +
        "operators directly — no npm dependencies. Use the `pages` parameter to limit " +
        "extraction (e.g. \"1-5\" or \"3\"). If the PDF is scanned/image-based and no " +
        "text can be extracted, the tool fails honestly and suggests using file_read_image " +
        "instead. Works best on programmatically generated PDFs with embedded text.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the PDF file." },
          pages: { type: "string", description: "Page range, e.g. \"1-5\" or \"3\". Omit for all pages." },
        },
        required: ["path"],
      },
      icon: "file-type",
      group: "filesystem",
      modes: ["cowork", "code"],
    },
    async handler(input, ctx) {
      const resolved = await resolvePath(str(input["path"]), {
        workingFolder: ctx.workingFolder,
      }).catch((e: unknown) => { if (e instanceof PathError) return e; throw e; });
      if (resolved instanceof PathError) return fail(resolved.message);

      const pages = input["pages"] ? str(input["pages"]) : undefined;

      let text: string;
      try {
        text = await extractPdfText(resolved, pages);
      } catch (e) {
        return fail(describeError(e));
      }

      if (!text) {
        return fail(
          `Could not extract text from ${displayPath(resolved, ctx.workingFolder)}. ` +
            `The PDF is likely scanned or image-based (no embedded text streams). ` +
            `Try file_read_image to pass the page as a visual into context.`,
        );
      }

      const dp = displayPath(resolved, ctx.workingFolder);
      return ok(text, {
        summary: `Extracted text from ${dp}`,
        files: [resolved],
      });
    },
  },

  /* ------------------------------------------------------------- file_search */
  {
    definition: {
      name: "file_search",
      title: "Search File Contents",
      description:
        "Recursively search files for a regex pattern. Returns matches in `file:line: content` " +
        "format. Automatically skips binary files (detected by NUL bytes in first 8KB) and " +
        "skips node_modules and .git directories. Use `glob` to restrict which files are " +
        "searched (e.g. \"**/*.ts\"). Limit results with maxResults. " +
        "Symlinks inside the search root are skipped.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regular expression to search for." },
          path: { type: "string", description: "Root directory to search. Defaults to working folder." },
          glob: { type: "string", description: "Glob filter for filenames, e.g. \"**/*.ts\"." },
          caseSensitive: { type: "boolean", description: "Case-sensitive match. Default true.", default: true },
          maxResults: { type: "integer", description: "Maximum number of matches to return. Default 100.", default: 100 },
        },
        required: ["pattern"],
      },
      icon: "search",
      group: "filesystem",
      modes: ["cowork", "code"],
    },
    async handler(input, ctx) {
      const rootInput = input["path"] ? str(input["path"]) : (ctx.workingFolder ?? process.cwd());
      const resolved = await resolvePath(rootInput, {
        workingFolder: ctx.workingFolder,
      }).catch((e: unknown) => { if (e instanceof PathError) return e; throw e; });
      if (resolved instanceof PathError) return fail(resolved.message);

      const patternStr = str(input["pattern"]);
      const globFilterStr = input["glob"] ? str(input["glob"]) : null;
      const caseSensitive = bool(input["caseSensitive"], true);
      const maxResults = Math.max(1, num(input["maxResults"]) ?? 100);

      // H7: reject the common nested-quantifier shape before any RegExp
      // evaluation. A worker budget is still used for other patterns, but a
      // catastrophic expression must never fall back to the main thread when
      // workers are unavailable (for example in a packaged Electron runtime).
      if (hasNestedQuantifier(patternStr)) {
        return fail("Regex pattern rejected: nested quantifiers can cause catastrophic backtracking.");
      }
      // Compile the user regex once. Pattern length is not capped because
      // length alone does not bound backtracking, but we impose a wall-clock
      // budget per file below.
      // Validate the pattern here so a bad regex fails fast with a clear
      // message; the worker compiles its own copy from patternStr.
      try {
        new RegExp(patternStr, caseSensitive ? "" : "i");
      } catch (e) {
        return fail(`Invalid regex pattern: ${describeError(e)}`);
      }

      // H7: compile the glob once (outside the walk loop) — avoids O(files) recompilation.
      let globTest: ((rel: string) => boolean) | null = null;
      if (globFilterStr) {
        try {
          globTest = compileGlob(globFilterStr);
        } catch (e) {
          return fail(`Invalid glob pattern: ${describeError(e)}`);
        }
      }

      // H7: wall-clock budget for regex matching across the whole search.
      const SEARCH_BUDGET_MS = 5000;
      const searchStart = Date.now();

      // H4: pass canonicalBase so walkDir can verify symlink targets stay inside.
      const canonicalBase = resolved; // resolvePath already returns the canonical path

      const matches: string[] = [];
      let timedOut = false;

      for await (const filePath of walkDir(resolved, canonicalBase)) {
        if (ctx.signal.aborted) break;
        if (matches.length >= maxResults) break;

        // H7: honour the elapsed budget between files.
        if (Date.now() - searchStart > SEARCH_BUDGET_MS) {
          timedOut = true;
          break;
        }

        // Apply glob filter (H7: compiled once above, not per file).
        if (globTest) {
          const rel = filePath.slice(resolved.length).replace(/^[\\/]/, "");
          if (!globTest(rel)) continue;
        }

        // Skip binaries
        if (await isBinary(filePath)) continue;

        let text: string;
        try {
          text = await readFile(filePath, "utf-8");
        } catch {
          continue;
        }

        // H7: run regex matching in a Worker thread with a per-file time budget.
        // This prevents catastrophic ReDoS patterns from blocking the main thread.
        const FILE_REGEX_BUDGET_MS = Math.max(
          500,
          SEARCH_BUDGET_MS - (Date.now() - searchStart),
        );
        const lines = text.split("\n");
        const result = await regexTestLines(
          patternStr,
          caseSensitive ? "" : "i",
          lines,
          FILE_REGEX_BUDGET_MS,
        );
        if ("timedOut" in result) {
          timedOut = true;
          break;
        }
        for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
          if (result.matches[i]) {
            matches.push(`${filePath}:${i + 1}: ${lines[i]}`);
          }
        }
        if (timedOut) break;
      }

      if (matches.length === 0 && !timedOut) {
        return ok(`No matches found for /${patternStr}/ in ${resolved}`, {
          summary: "No matches found",
        });
      }

      if (timedOut) {
        const dp = displayPath(resolved, ctx.workingFolder);
        const prefix = matches.length > 0
          ? `${matches.join("\n")}\n\n`
          : "";
        return ok(
          `${prefix}[Search stopped after ${SEARCH_BUDGET_MS}ms time budget. ` +
            `${matches.length} match(es) found before stopping. ` +
            "The pattern may be too expensive — simplify it or narrow the search path.]",
          {
            summary: `${matches.length} match(es) in ${dp} (time budget hit)`,
          },
        );
      }

      const dp = displayPath(resolved, ctx.workingFolder);
      return ok(matches.join("\n"), {
        summary: `Found ${matches.length} match(es) in ${dp}`,
      });
    },
  },

  /* ------------------------------------------------------------- glob_match */
  {
    definition: {
      name: "glob_match",
      title: "Glob Match",
      description:
        "Find files matching a glob pattern (e.g. **/*.ts, src/**/*.{ts,tsx}, *.md). " +
        "Supports **, *, ?, {a,b} alternation, and [char] character classes. " +
        "Returns matching file paths relative to the root. Skips node_modules, .git, " +
        "and symlinks.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern, e.g. **/*.ts or src/**/*.{ts,tsx}." },
          root: { type: "string", description: "Root directory to search. Defaults to working folder." },
        },
        required: ["pattern"],
      },
      icon: "git-branch",
      group: "filesystem",
      modes: ["cowork", "code"],
    },
    async handler(input, ctx) {
      const rootInput = input["root"] ? str(input["root"]) : (ctx.workingFolder ?? process.cwd());
      const resolved = await resolvePath(rootInput, {
        workingFolder: ctx.workingFolder,
      }).catch((e: unknown) => { if (e instanceof PathError) return e; throw e; });
      if (resolved instanceof PathError) return fail(resolved.message);

      const pattern = str(input["pattern"]);

      // H7: compile glob once (not per file in the loop).
      let globTest: (rel: string) => boolean;
      try {
        globTest = compileGlob(pattern);
      } catch (e) {
        return fail(`Invalid glob pattern: ${describeError(e)}`);
      }

      // H4: pass canonicalBase so walkDir skips symlinks pointing outside.
      const canonicalBase = resolved;

      const results: string[] = [];
      for await (const filePath of walkDir(resolved, canonicalBase)) {
        const rel = filePath.slice(resolved.length).replace(/^[\\/]/, "").replace(/\\/g, "/");
        if (globTest(rel)) {
          results.push(rel);
        }
      }

      results.sort();

      if (results.length === 0) {
        return ok(`No files matched pattern "${pattern}" in ${resolved}`, {
          summary: `No matches for ${pattern}`,
        });
      }

      const dp = displayPath(resolved, ctx.workingFolder);
      return ok(results.join("\n"), {
        summary: `${results.length} file(s) matched ${pattern} in ${dp}`,
      });
    },
  },
];

/* ---------------------------------------------------------------- util */

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

// Re-export for tests
export { matchGlob };

function hasNestedQuantifier(pattern: string): boolean {
  // Conservative guard for a repeated group containing a repeated atom, e.g.
  // (a+)+, (.*)*, or ([a-z]*|x)+. It intentionally rejects only the shape
  // responsible for the known catastrophic cases and leaves ordinary regexes
  // to the worker-budgeted path.
  return /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)(?:[+*]|\{\d)/.test(pattern);
}

/* ------------------------------------------------------- worker-thread shim */

/**
 * When this module is loaded as a Worker (isMainThread is false), execute the
 * regex-test task from workerData and post the result.
 *
 * workerData: { pattern: string, flags: string, lines: string[] }
 * postMessage: { matches: boolean[] } | { error: string }
 */
if (!isMainThread && parentPort) {
  const { pattern, flags, lines } = workerData as {
    pattern: string;
    flags: string;
    lines: string[];
  };
  try {
    const re = new RegExp(pattern, flags);
    const matches: boolean[] = lines.map((l) => re.test(l));
    parentPort.postMessage({ matches });
  } catch (e) {
    parentPort.postMessage({ error: String(e) });
  }
}

/**
 * Set once a Worker spawn fails (e.g. ERR_WORKER_INVALID_EXEC_ARGV when the
 * parent's Node flags are rejected by the worker runtime on some Windows
 * Node/Electron builds). Subsequent searches skip straight to the in-thread
 * fallback instead of paying a failed spawn per file.
 */
let workerUnavailable = false;

/** Test hook: force the in-thread fallback as if Worker spawns had failed. */
export function _setRegexWorkerUnavailableForTests(v: boolean): void {
  workerUnavailable = v;
}

/**
 * Capped in-thread regex evaluation — the fallback used when Worker threads
 * cannot be spawned. Lines are pre-capped by the caller, which bounds (but
 * does not eliminate) catastrophic-backtracking damage; a coarse budget check
 * between lines keeps typical pathological patterns from running away.
 */
export function inThreadRegexTest(
  pattern: string,
  flags: string,
  lines: string[],
  budgetMs: number,
): { matches: boolean[] } | { timedOut: true } {
  const start = Date.now();
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags);
  } catch {
    return { matches: lines.map(() => false) };
  }
  const matches: boolean[] = new Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    if ((i & 127) === 0 && Date.now() - start > budgetMs) return { timedOut: true };
    let hit = false;
    try {
      hit = re.test(lines[i]);
    } catch {
      hit = false;
    }
    matches[i] = hit;
  }
  return { matches };
}

/**
 * Attempt one Worker-thread regex pass. Resolves:
 *   - { matches }          on success,
 *   - { timedOut: true }   when the wall-clock budget is exceeded,
 *   - null                 when the worker could not be spawned at all
 *                          (exec argv rejection, load failure), signalling the
 *                          caller to fall back to in-thread evaluation.
 */
function tryWorkerRegexTestLines(
  pattern: string,
  flags: string,
  cappedLines: string[],
  budgetMs: number,
): Promise<{ matches: boolean[] } | { timedOut: true } | null> {
  return new Promise((resolve) => {
    let settled = false;
    let worker: Worker;
    try {
      // Explicit execArgv override: without it workers inherit parent Node
      // options such as --experimental-strip-types, which this Node/Electron
      // build rejects inside worker runtimes (ERR_WORKER_INVALID_EXEC_ARGV).
      // The built app runs compiled .js and needs no flag either way.
      worker = new Worker(new URL(import.meta.url), {
        workerData: { pattern, flags, lines: cappedLines },
        execArgv: [],
      });
    } catch {
      resolve(null);
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.terminate().catch(() => undefined);
      resolve({ timedOut: true });
    }, budgetMs);

    worker.on("message", (msg: { matches: boolean[] } | { error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => undefined);
      if ("error" in msg) {
        resolve(inThreadRegexTest(pattern, flags, cappedLines, budgetMs));
      } else {
        resolve(msg);
      }
    });

    worker.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => undefined);
      resolve(null);
    });

    worker.on("exit", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/**
 * Run regex.test() against each line in `lines`, preferring a Worker thread
 * with a wall-clock budget so catastrophic patterns cannot block the main
 * thread. If workers are unavailable on this runtime (spawn failure), fall
 * back to capped in-thread evaluation so file_search degrades gracefully
 * instead of dying with ERR_WORKER_INVALID_EXEC_ARGV.
 */
async function regexTestLines(
  pattern: string,
  flags: string,
  lines: string[],
  budgetMs: number,
): Promise<{ matches: boolean[] } | { timedOut: true }> {
  // Cap each line to prevent worker-internal catastrophic backtracking on a
  // single excessively long line.
  const MAX_WORKER_LINE_LEN = 2048;
  const cappedLines = lines.map((l) => l.slice(0, MAX_WORKER_LINE_LEN));

  if (!workerUnavailable) {
    const result = await tryWorkerRegexTestLines(pattern, flags, cappedLines, budgetMs);
    if (result !== null) return result;
    workerUnavailable = true;
  }
  return inThreadRegexTest(pattern, flags, cappedLines, budgetMs);
}

