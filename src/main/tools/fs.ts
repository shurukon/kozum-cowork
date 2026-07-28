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
} from "node:fs/promises";
import { createInflate } from "node:zlib";
import { extname, dirname, join, sep } from "node:path";

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

/** Recursively walk a directory, yielding file paths. */
async function* walkDir(dir: string): AsyncGenerator<string> {
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
      yield* walkDir(full);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      yield full;
    }
  }
}

/* ------------------------------------------------------ glob_match helpers */

/**
 * Convert a glob pattern into a RegExp.
 * Supports **, *, ?, {a,b,c}, [chars].
 */
function globToRegex(pattern: string): RegExp {
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
      }
    }
    return results;
  }

  function singleGlobToRegexSrc(p: string): string {
    let src = "";
    let i = 0;
    while (i < p.length) {
      const ch = p[i]!;
      if (ch === "*") {
        if (p[i + 1] === "*") {
          // ** matches any path segment including slashes
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

/* ------------------------------------------------------------------ PDF */

/** Very basic PDF BT/ET text extraction without external deps. */
async function extractPdfText(path: string, pages?: string): Promise<string> {
  const buf = await readFile(path);
  const raw = buf.toString("binary");

  // Parse requested page range
  let wantedPages: Set<number> | null = null;
  if (pages) {
    wantedPages = new Set<number>();
    for (const part of pages.split(",")) {
      const rangePart = part.trim();
      const dash = rangePart.indexOf("-");
      if (dash !== -1) {
        const from = parseInt(rangePart.slice(0, dash), 10);
        const to = parseInt(rangePart.slice(dash + 1), 10);
        for (let p = from; p <= to; p++) wantedPages.add(p);
      } else {
        const n = parseInt(rangePart, 10);
        if (!isNaN(n)) wantedPages.add(n);
      }
    }
  }

  // Find all stream objects with FlateDecode (or no filter for plain streams)
  const streamTexts: string[] = [];
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

    // Extract text from BT/ET blocks
    const btBlocks = text.match(/BT[\s\S]*?ET/g) ?? [];
    for (const block of btBlocks) {
      // Tj: (text) Tj  or  (text) Tj
      const tjMatches = block.matchAll(/\(([^)]*)\)\s*Tj/g);
      for (const tj of tjMatches) {
        streamTexts.push(decodePdfString(tj[1] ?? ""));
      }
      // TJ: [(text) ...] TJ
      const tjArrMatches = block.matchAll(/\[([^\]]*)\]\s*TJ/g);
      for (const tjArr of tjArrMatches) {
        const inner = tjArr[1] ?? "";
        const parts = inner.matchAll(/\(([^)]*)\)/g);
        for (const part of parts) {
          streamTexts.push(decodePdfString(part[1] ?? ""));
        }
      }
    }
  }

  const combined = streamTexts.join(" ").replace(/\s+/g, " ").trim();
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
        "`limit` to cap the number of lines returned. Large files are automatically " +
        "truncated with a note. Use file_read_image for images and file_read_pdf for PDFs.",
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
      if (rawLimit !== undefined && rawLimit > 0) {
        end = start + rawLimit;
      }

      const sliced = lines.slice(start, end);
      let content = sliced.join("\n");
      let truncNote = "";
      if (end < lines.length) {
        truncNote = `\n\n[File truncated: showing lines ${start + 1}–${end} of ${lines.length}]`;
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
        "blob the model can see. Requires a vision-capable model. Use this when you need " +
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
      requiresVision: true,
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
            `Try file_read_image to pass the page as a visual to a vision model.`,
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
        "searched (e.g. \"**/*.ts\"). Limit results with maxResults.",
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
      const globFilter = input["glob"] ? str(input["glob"]) : null;
      const caseSensitive = bool(input["caseSensitive"], true);
      const maxResults = Math.max(1, num(input["maxResults"]) ?? 100);

      let regex: RegExp;
      try {
        regex = new RegExp(patternStr, caseSensitive ? "" : "i");
      } catch (e) {
        return fail(`Invalid regex pattern: ${describeError(e)}`);
      }

      const matches: string[] = [];

      for await (const filePath of walkDir(resolved)) {
        if (matches.length >= maxResults) break;

        // Apply glob filter
        if (globFilter) {
          const rel = filePath.slice(resolved.length).replace(/^[\\/]/, "");
          if (!matchGlob(globFilter, rel)) continue;
        }

        // Skip binaries
        if (await isBinary(filePath)) continue;

        let text: string;
        try {
          text = await readFile(filePath, "utf-8");
        } catch {
          continue;
        }

        const lines = text.split("\n");
        for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
          if (regex.test(lines[i]!)) {
            matches.push(`${filePath}:${i + 1}: ${lines[i]}`);
          }
        }
      }

      if (matches.length === 0) {
        return ok(`No matches found for /${patternStr}/ in ${resolved}`, {
          summary: "No matches found",
        });
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
        "Returns matching file paths relative to the root. Skips node_modules and .git.",
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
      const results: string[] = [];

      for await (const filePath of walkDir(resolved)) {
        const rel = filePath.slice(resolved.length).replace(/^[\\/]/, "").replace(/\\/g, "/");
        if (matchGlob(pattern, rel)) {
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
