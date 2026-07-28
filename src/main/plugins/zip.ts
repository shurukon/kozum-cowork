/**
 * Pure-Node ZIP reader/extractor.
 *
 * Parses the End-of-Central-Directory record, walks the central directory,
 * and inflates STORED (method 0) and DEFLATE (method 8) entries using
 * node:zlib inflateRaw. No third-party dependencies.
 *
 * Security:
 *   - Zip-slip guard: any entry whose resolved path escapes destDir aborts the
 *     entire extraction (nothing is written outside destDir).
 *   - Absolute paths rejected.
 *   - Entries containing ".." path segments rejected.
 *   - Zip-bomb guard: total uncompressed size capped at MAX_TOTAL_BYTES.
 *   - Entry count capped at MAX_ENTRIES.
 */

import { inflateRaw } from "node:zlib";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve, normalize, isAbsolute, dirname } from "node:path";

const inflateRawAsync = promisify(inflateRaw);

/* ----------------------------------------------------------------- limits */

const MAX_ENTRIES = 10_000;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024; // 512 MiB

/* ----------------------------------------------------------- data types --- */

export interface ZipEntry {
  /** UTF-8 name stored in the central directory. */
  name: string;
  /** Compression method: 0 = STORED, 8 = DEFLATE. */
  method: number;
  /** Size after decompression. */
  uncompressedSize: number;
  /** Size on disk inside the ZIP. */
  compressedSize: number;
  /** Offset of the Local File Header from the start of the ZIP. */
  localHeaderOffset: number;
  /** True when this entry is a directory (name ends with '/'). */
  isDirectory: boolean;
}

/* ------------------------------------------------------------ signatures */

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/* ---------------------------------------------------------------- read32 */

function readUInt16LE(buf: Buffer, offset: number): number {
  return buf.readUInt16LE(offset);
}

function readUInt32LE(buf: Buffer, offset: number): number {
  return buf.readUInt32LE(offset);
}

function readBigUInt64LE(buf: Buffer, offset: number): bigint {
  return buf.readBigUInt64LE(offset);
}

/* ------------------------------------------------- find EOCD record --- */

/**
 * Locate the End-of-Central-Directory record.
 * Scans backward from the end of the buffer to handle ZIP comment.
 */
function findEOCD(buf: Buffer): number {
  // Minimum EOCD size is 22 bytes
  const min = buf.length - 22;
  // Maximum comment length is 0xFFFF
  const start = Math.max(0, buf.length - 22 - 0xffff);

  for (let i = min; i >= start; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      return i;
    }
  }
  throw new Error("ZIP: End-of-Central-Directory record not found — not a valid ZIP file.");
}

/* ------------------------------------------------- parse central dir --- */

/**
 * Parse the ZIP central directory and return an array of entries.
 */
export async function readZipEntries(buf: Buffer): Promise<ZipEntry[]> {
  if (buf.length < 22) {
    throw new Error("ZIP: Buffer too small to be a valid ZIP file.");
  }

  const eocdOffset = findEOCD(buf);

  // Check for ZIP64 locator just before EOCD
  let cdOffset: number;
  let cdSize: number;
  let totalEntries: number;

  const zip64LocOffset = eocdOffset - 20;
  if (zip64LocOffset >= 0 && buf.readUInt32LE(zip64LocOffset) === SIG_EOCD64_LOCATOR) {
    // ZIP64 format
    const eocd64Offset = Number(readBigUInt64LE(buf, zip64LocOffset + 8));
    if (eocd64Offset + 56 > buf.length || buf.readUInt32LE(eocd64Offset) !== SIG_EOCD64) {
      throw new Error("ZIP: Invalid ZIP64 EOCD64 record.");
    }
    totalEntries = Number(readBigUInt64LE(buf, eocd64Offset + 32));
    cdSize = Number(readBigUInt64LE(buf, eocd64Offset + 40));
    cdOffset = Number(readBigUInt64LE(buf, eocd64Offset + 48));
  } else {
    // Standard ZIP32
    totalEntries = readUInt16LE(buf, eocdOffset + 10);
    cdSize = readUInt32LE(buf, eocdOffset + 12);
    cdOffset = readUInt32LE(buf, eocdOffset + 16);

    // Handle ZIP64 overflow values
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff || totalEntries === 0xffff) {
      throw new Error("ZIP: ZIP64 archive detected without ZIP64 locator; cannot read.");
    }
  }

  if (cdOffset + cdSize > buf.length) {
    throw new Error("ZIP: Central directory extends beyond end of buffer.");
  }

  if (totalEntries > MAX_ENTRIES) {
    throw new Error(
      `ZIP: Entry count ${totalEntries} exceeds the cap of ${MAX_ENTRIES}.`,
    );
  }

  const entries: ZipEntry[] = [];
  let pos = cdOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > buf.length) {
      throw new Error(`ZIP: Central directory record ${i} is truncated.`);
    }
    if (buf.readUInt32LE(pos) !== SIG_CENTRAL) {
      throw new Error(`ZIP: Expected central directory signature at offset ${pos}.`);
    }

    const method = readUInt16LE(buf, pos + 10);
    const compressedSize = readUInt32LE(buf, pos + 20);
    const uncompressedSize = readUInt32LE(buf, pos + 24);
    const fileNameLen = readUInt16LE(buf, pos + 28);
    const extraLen = readUInt16LE(buf, pos + 30);
    const commentLen = readUInt16LE(buf, pos + 32);
    const localHeaderOffset = readUInt32LE(buf, pos + 42);

    if (pos + 46 + fileNameLen > buf.length) {
      throw new Error(`ZIP: Filename in central directory record ${i} is truncated.`);
    }

    // General purpose bit 11 = UTF-8 filename
    const gpFlag = readUInt16LE(buf, pos + 8);
    const encoding = (gpFlag & (1 << 11)) ? "utf-8" : "latin1";
    const name = buf.slice(pos + 46, pos + 46 + fileNameLen).toString(encoding);

    // Check for ZIP64 extra field
    let actualCompressedSize = compressedSize;
    let actualUncompressedSize = uncompressedSize;
    let actualLocalHeaderOffset = localHeaderOffset;

    if (extraLen > 0) {
      const extraStart = pos + 46 + fileNameLen;
      let extraPos = extraStart;
      while (extraPos + 4 <= extraStart + extraLen) {
        const tag = readUInt16LE(buf, extraPos);
        const size = readUInt16LE(buf, extraPos + 2);
        if (tag === 0x0001) {
          // ZIP64 extended information
          let z64Pos = extraPos + 4;
          if (uncompressedSize === 0xffffffff && z64Pos + 8 <= extraPos + 4 + size) {
            actualUncompressedSize = Number(readBigUInt64LE(buf, z64Pos));
            z64Pos += 8;
          }
          if (compressedSize === 0xffffffff && z64Pos + 8 <= extraPos + 4 + size) {
            actualCompressedSize = Number(readBigUInt64LE(buf, z64Pos));
            z64Pos += 8;
          }
          if (localHeaderOffset === 0xffffffff && z64Pos + 8 <= extraPos + 4 + size) {
            actualLocalHeaderOffset = Number(readBigUInt64LE(buf, z64Pos));
          }
          break;
        }
        extraPos += 4 + size;
      }
    }

    entries.push({
      name,
      method,
      compressedSize: actualCompressedSize,
      uncompressedSize: actualUncompressedSize,
      localHeaderOffset: actualLocalHeaderOffset,
      isDirectory: name.endsWith("/"),
    });

    pos += 46 + fileNameLen + extraLen + commentLen;
  }

  return entries;
}

/* -------------------------------------------------- extract one entry --- */

async function extractEntry(
  buf: Buffer,
  entry: ZipEntry,
  localHeaderOffset: number,
): Promise<Buffer> {
  if (entry.isDirectory) return Buffer.alloc(0);

  const pos = localHeaderOffset;
  if (pos + 30 > buf.length || buf.readUInt32LE(pos) !== SIG_LOCAL) {
    throw new Error(
      `ZIP: Expected local file header signature at offset ${pos} for "${entry.name}".`,
    );
  }

  const fileNameLen = readUInt16LE(buf, pos + 26);
  const extraLen = readUInt16LE(buf, pos + 28);
  const dataOffset = pos + 30 + fileNameLen + extraLen;

  if (dataOffset + entry.compressedSize > buf.length) {
    throw new Error(`ZIP: Compressed data for "${entry.name}" extends beyond buffer.`);
  }

  const compressed = buf.slice(dataOffset, dataOffset + entry.compressedSize);

  if (entry.method === 0) {
    // STORED — no compression
    if (compressed.length !== entry.uncompressedSize) {
      throw new Error(
        `ZIP: STORED entry "${entry.name}" has size mismatch: ` +
          `expected ${entry.uncompressedSize}, got ${compressed.length}.`,
      );
    }
    return compressed;
  }

  if (entry.method === 8) {
    // DEFLATE
    const result = await inflateRawAsync(compressed);
    if (result.length !== entry.uncompressedSize) {
      throw new Error(
        `ZIP: DEFLATE entry "${entry.name}" decompressed to ${result.length} bytes, ` +
          `expected ${entry.uncompressedSize}.`,
      );
    }
    return result;
  }

  throw new Error(
    `ZIP: Unsupported compression method ${entry.method} for "${entry.name}". ` +
      `Only STORED (0) and DEFLATE (8) are supported.`,
  );
}

/* ---------------------------------------------- security checks --- */

/**
 * Validate an entry name against zip-slip and other attacks.
 * Returns an error string if the name is invalid, or null if OK.
 */
function validateEntryName(name: string): string | null {
  if (!name) return "Entry has an empty name.";

  // Reject absolute paths
  if (isAbsolute(name)) {
    return `Entry "${name}" has an absolute path — rejected.`;
  }

  // Normalize separators
  const normalized = normalize(name.replace(/\\/g, "/"));

  // Reject any ".." segment
  const parts = normalized.split("/");
  for (const part of parts) {
    if (part === "..") {
      return `Entry "${name}" contains ".." — zip-slip rejected.`;
    }
  }

  return null;
}

/* -------------------------------------------------- main extractor --- */

/**
 * Extract all entries from a ZIP buffer into `destDir`.
 *
 * Zip-slip protection: any entry whose resolved path escapes destDir causes
 * the entire extraction to abort before writing anything.
 */
export async function extractZip(buf: Buffer, destDir: string): Promise<void> {
  const entries = await readZipEntries(buf);

  // Zip-bomb guard: total uncompressed size
  let totalSize = 0;
  for (const entry of entries) {
    if (!entry.isDirectory) {
      totalSize += entry.uncompressedSize;
    }
  }
  if (totalSize > MAX_TOTAL_BYTES) {
    throw new Error(
      `ZIP: Total uncompressed size ${totalSize} exceeds the limit of ${MAX_TOTAL_BYTES} bytes (zip-bomb guard).`,
    );
  }

  // Security pre-check: validate ALL entries before writing anything
  const resolvedDest = resolve(destDir);
  const plan: Array<{ entry: ZipEntry; outPath: string }> = [];

  for (const entry of entries) {
    const nameErr = validateEntryName(entry.name);
    if (nameErr) {
      throw new Error(`ZIP: ${nameErr}`);
    }

    const outPath = join(resolvedDest, entry.name);
    const resolvedOut = resolve(outPath);

    // Zip-slip: check that resolved output path is inside destDir
    const destWithSep = resolvedDest.endsWith("/") ? resolvedDest : resolvedDest + "/";
    if (resolvedOut !== resolvedDest && !resolvedOut.startsWith(destWithSep)) {
      throw new Error(
        `ZIP: Entry "${entry.name}" would extract to "${resolvedOut}" which escapes ` +
          `destDir "${resolvedDest}" — zip-slip rejected. Aborting entire extraction.`,
      );
    }

    plan.push({ entry, outPath });
  }

  // Now perform the actual extraction
  for (const { entry, outPath } of plan) {
    if (entry.isDirectory) {
      await mkdir(outPath, { recursive: true });
    } else {
      await mkdir(dirname(outPath), { recursive: true });
      const data = await extractEntry(buf, entry, entry.localHeaderOffset);
      await writeFile(outPath, data);
    }
  }
}
