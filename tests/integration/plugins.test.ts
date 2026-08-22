/**
 * Integration tests for the plugin engine.
 *
 * Uses node:test + node:assert/strict.
 * Builds real ZIP bytes in-process (tiny writer helper below).
 * Serves real HTTP for GitHub-install tests.
 * Uses real temp dirs throughout; cleans up after each test.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { deflateRawSync } from "node:zlib";
import type { IncomingMessage, ServerResponse } from "node:http";

import { readZipEntries, extractZip } from "../../src/main/plugins/zip.ts";
import { parsePluginManifest, parseMarketplace } from "../../src/main/plugins/manifest.ts";
import { discoverContributions } from "../../src/main/plugins/discover.ts";
import { PluginManager } from "../../src/main/plugins/manager.ts";

/* ================================================================ ZIP WRITER */

/**
 * Minimal in-process ZIP writer — just enough for round-trip testing.
 * Produces valid ZIP32 with optional DEFLATE compression.
 */

interface ZipWriterEntry {
  name: string;
  data: Buffer;
  method?: 0 | 8; // STORED | DEFLATE
}

function buildZip(entries: ZipWriterEntry[]): Buffer {
  const localHeaders: Buffer[] = [];
  const centralDir: Buffer[] = [];
  const offsets: number[] = [];
  let currentOffset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf-8");
    const method = entry.method ?? 0;
    const uncompressedSize = entry.data.length;
    const compressedData = method === 8 ? deflateRawSync(entry.data) : entry.data;
    const compressedSize = compressedData.length;

    // CRC-32
    const crc = crc32(entry.data);

    // Local file header (30 + name)
    const localHeader = Buffer.alloc(30 + nameBytes.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(1 << 11, 6); // UTF-8 flag
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt32LE(0, 10); // last mod time/date
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressedSize, 18);
    localHeader.writeUInt32LE(uncompressedSize, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28); // no extra
    nameBytes.copy(localHeader, 30);

    offsets.push(currentOffset);
    localHeaders.push(localHeader);
    localHeaders.push(compressedData);
    currentOffset += localHeader.length + compressedData.length;

    // Central directory entry (46 + name)
    const cdEntry = Buffer.alloc(46 + nameBytes.length);
    cdEntry.writeUInt32LE(0x02014b50, 0);
    cdEntry.writeUInt16LE(20, 4); // version made
    cdEntry.writeUInt16LE(20, 6); // version needed
    cdEntry.writeUInt16LE(1 << 11, 8); // UTF-8
    cdEntry.writeUInt16LE(method, 10);
    cdEntry.writeUInt32LE(0, 12); // last mod
    cdEntry.writeUInt32LE(crc, 16);
    cdEntry.writeUInt32LE(compressedSize, 20);
    cdEntry.writeUInt32LE(uncompressedSize, 24);
    cdEntry.writeUInt16LE(nameBytes.length, 28);
    cdEntry.writeUInt16LE(0, 30); // extra len
    cdEntry.writeUInt16LE(0, 32); // comment len
    cdEntry.writeUInt16LE(0, 34); // disk start
    cdEntry.writeUInt16LE(0, 36); // int attr
    cdEntry.writeUInt32LE(0, 38); // ext attr
    cdEntry.writeUInt32LE(offsets[offsets.length - 1]!, 42);
    nameBytes.copy(cdEntry, 46);
    centralDir.push(cdEntry);
  }

  const cdBuf = Buffer.concat(centralDir);
  const cdOffset = currentOffset;

  // End of central directory
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localHeaders, cdBuf, eocd]);
}

/* --------------------------------------------------------- CRC-32 --- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = (CRC_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}

/* ========================================================= helpers */

/** Build a minimal valid plugin ZIP with optional extra files. */
function buildPluginZip(opts: {
  name?: string;
  version?: string;
  description?: string;
  author?: string;
  extraFiles?: ZipWriterEntry[];
  wrapInDir?: string; // wrap all entries in this dir (simulates GitHub archive)
}): Buffer {
  const manifest = JSON.stringify({
    name: opts.name ?? "test-plugin",
    version: opts.version ?? "1.0.0",
    description: opts.description ?? "A test plugin",
    ...(opts.author ? { author: opts.author } : {}),
  });

  const entries: ZipWriterEntry[] = [
    { name: ".claude-plugin/plugin.json", data: Buffer.from(manifest, "utf-8") },
    ...(opts.extraFiles ?? []),
  ];

  if (opts.wrapInDir) {
    const prefix = opts.wrapInDir.endsWith("/") ? opts.wrapInDir : `${opts.wrapInDir}/`;
    return buildZip(entries.map((e) => ({ ...e, name: `${prefix}${e.name}` })));
  }

  return buildZip(entries);
}

/* ========================================================= readZipEntries */

describe("readZipEntries", () => {
  it("reads STORED entries", async () => {
    const data = Buffer.from("hello world", "utf-8");
    const zip = buildZip([{ name: "hello.txt", data, method: 0 }]);
    const entries = await readZipEntries(zip);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.name, "hello.txt");
    assert.equal(entries[0]!.method, 0);
    assert.equal(entries[0]!.uncompressedSize, data.length);
    assert.equal(entries[0]!.isDirectory, false);
  });

  it("reads DEFLATE entries", async () => {
    const data = Buffer.from("a".repeat(1000), "utf-8");
    const zip = buildZip([{ name: "big.txt", data, method: 8 }]);
    const entries = await readZipEntries(zip);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.method, 8);
    assert.equal(entries[0]!.uncompressedSize, 1000);
    assert(entries[0]!.compressedSize < 1000, "DEFLATE should compress repetitive data");
  });

  it("reads directory entries", async () => {
    const zip = buildZip([
      { name: "mydir/", data: Buffer.alloc(0), method: 0 },
      { name: "mydir/file.txt", data: Buffer.from("x"), method: 0 },
    ]);
    const entries = await readZipEntries(zip);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]!.isDirectory, true);
    assert.equal(entries[1]!.isDirectory, false);
  });

  it("reads UTF-8 filenames", async () => {
    const zip = buildZip([{ name: "日本語/ファイル.txt", data: Buffer.from("こんにちは"), method: 0 }]);
    const entries = await readZipEntries(zip);
    assert.equal(entries[0]!.name, "日本語/ファイル.txt");
  });

  it("reads nested directories", async () => {
    const zip = buildZip([
      { name: "a/b/c/deep.txt", data: Buffer.from("deep"), method: 0 },
    ]);
    const entries = await readZipEntries(zip);
    assert.equal(entries[0]!.name, "a/b/c/deep.txt");
  });

  it("rejects truncated buffer", async () => {
    await assert.rejects(
      () => readZipEntries(Buffer.from("not a zip")),
      /too small|not a valid ZIP/i,
    );
  });
});

/* ========================================================= extractZip */

describe("extractZip", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "kozum-zip-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("round-trips STORED entries", async () => {
    const data = Buffer.from("stored content", "utf-8");
    const zip = buildZip([{ name: "file.txt", data, method: 0 }]);
    await extractZip(zip, tmpDir);
    const result = await readFile(join(tmpDir, "file.txt"));
    assert.deepEqual(result, data);
  });

  it("round-trips DEFLATE entries", async () => {
    const data = Buffer.from("deflate content ".repeat(100), "utf-8");
    const zip = buildZip([{ name: "big.txt", data, method: 8 }]);
    await extractZip(zip, tmpDir);
    const result = await readFile(join(tmpDir, "big.txt"));
    assert.deepEqual(result, data);
  });

  it("creates nested directories", async () => {
    const zip = buildZip([
      { name: "a/b/c/", data: Buffer.alloc(0), method: 0 },
      { name: "a/b/c/file.txt", data: Buffer.from("nested"), method: 0 },
    ]);
    await extractZip(zip, tmpDir);
    const content = await readFile(join(tmpDir, "a", "b", "c", "file.txt"), "utf-8");
    assert.equal(content, "nested");
  });

  it("rejects zip-slip via ../../ entry name", async () => {
    const zip = buildZip([{ name: "../../evil.txt", data: Buffer.from("evil"), method: 0 }]);
    await assert.rejects(
      () => extractZip(zip, tmpDir),
      /zip-slip/i,
    );
    // Verify the file was NOT written outside tmpDir
    const parent = join(tmpDir, "..", "..");
    try {
      await stat(join(parent, "evil.txt"));
      assert.fail("evil.txt should not have been written");
    } catch (e) {
      assert.equal((e as NodeJS.ErrnoException).code, "ENOENT");
    }
  });

  it("rejects absolute path entries", async () => {
    // Manually build a zip with an absolute path to bypass our writer's checks
    const nameBytes = Buffer.from("/etc/passwd", "utf-8");
    const data = Buffer.from("root:x:0:0:", "utf-8");
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(1 << 11, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);

    const cd = Buffer.alloc(46 + nameBytes.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(1 << 11, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt32LE(0, 12);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBytes.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(0, 42);
    nameBytes.copy(cd, 46);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(local.length + data.length, 16);

    const zip = Buffer.concat([local, data, cd, eocd]);

    await assert.rejects(
      () => extractZip(zip, tmpDir),
      /absolute path/i,
    );
  });

  it("trips zip-bomb guard on declared oversized entry", async () => {
    // Build a ZIP where the central directory declares a huge uncompressedSize
    // but the actual data is tiny (we won't actually decompress it — the size
    // check happens before extraction).
    const nameBytes = Buffer.from("bomb.txt", "utf-8");
    const data = Buffer.alloc(10, 0x78); // tiny compressed data
    const hugeSize = 600 * 1024 * 1024; // 600 MiB > 512 MiB limit
    const crc = crc32(Buffer.alloc(0));

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6); // no UTF-8 flag so latin1 name
    local.writeUInt16LE(8, 8); // DEFLATE
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressedSize
    local.writeUInt32LE(hugeSize, 22); // declared uncompressedSize
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);

    const cd = Buffer.alloc(46 + nameBytes.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10); // DEFLATE
    cd.writeUInt32LE(0, 12);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(hugeSize, 24); // declared uncompressedSize
    cd.writeUInt16LE(nameBytes.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(0, 42);
    nameBytes.copy(cd, 46);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(local.length + data.length, 16);

    const zip = Buffer.concat([local, data, cd, eocd]);
    await assert.rejects(
      () => extractZip(zip, tmpDir),
      /zip-bomb/i,
    );
  });
});

/* ========================================================= parsePluginManifest */

describe("parsePluginManifest", () => {
  it("parses a valid manifest", () => {
    const json = { name: "My Plugin", description: "Desc", version: "1.2.3", author: "Alice" };
    const result = parsePluginManifest(json, "test.json");
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.value.name, "My Plugin");
    assert.equal(result.value.description, "Desc");
    assert.equal(result.value.version, "1.2.3");
    assert.equal(result.value.author, "Alice");
  });

  it("returns error for missing name", () => {
    const result = parsePluginManifest({ description: "No name" }, "test.json");
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.match(result.error, /name/i);
  });

  it("returns error for malformed JSON string", () => {
    const result = parsePluginManifest("{not valid json}", "test.json");
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.match(result.error, /invalid JSON/i);
  });

  it("returns error for non-object JSON", () => {
    const result = parsePluginManifest([1, 2, 3], "test.json");
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.match(result.error, /object/i);
  });

  it("defaults version to 0.0.0 when missing", () => {
    const result = parsePluginManifest({ name: "Minimal" }, "test.json");
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.value.version, "0.0.0");
  });

  it("accepts a valid JSON string", () => {
    const result = parsePluginManifest(JSON.stringify({ name: "StringPlugin" }), "test.json");
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.value.name, "StringPlugin");
  });

  it("never throws on malformed input", () => {
    // These should all return error results, never throw
    const inputs = [null, undefined, 42, "bad{json", [], { name: "" }];
    for (const input of inputs) {
      assert.doesNotThrow(() => parsePluginManifest(input, "test.json"));
    }
  });
});

/* ========================================================= parseMarketplace */

describe("parseMarketplace", () => {
  it("parses a valid marketplace with 2 plugins", () => {
    const json = {
      name: "My Marketplace",
      owner: "acme",
      plugins: [
        {
          name: "plugin-a",
          source: { kind: "github", repo: "acme/plugin-a" },
          description: "Plugin A",
          version: "1.0.0",
          category: "tools",
          tags: ["test"],
        },
        {
          name: "plugin-b",
          source: { kind: "github", repo: "acme/plugin-b" },
          description: "Plugin B",
        },
      ],
    };
    const result = parseMarketplace(json);
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.value.name, "My Marketplace");
    assert.equal(result.value.owner, "acme");
    assert.equal(result.value.plugins.length, 2);
    assert.equal(result.value.plugins[0]!.name, "plugin-a");
    assert.equal(result.value.plugins[1]!.name, "plugin-b");
  });

  it("returns error for missing name field", () => {
    const result = parseMarketplace({ owner: "x", plugins: [] });
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.match(result.error, /name/i);
  });

  it("returns error for missing owner field", () => {
    const result = parseMarketplace({ name: "X", plugins: [] });
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.match(result.error, /owner/i);
  });

  it("returns error for malformed JSON string", () => {
    const result = parseMarketplace("{bad json}");
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.match(result.error, /invalid JSON/i);
  });

  it("returns error for plugins not being an array", () => {
    const result = parseMarketplace({ name: "X", owner: "y", plugins: "not-an-array" });
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.match(result.error, /array/i);
  });

  it("never throws on malformed input", () => {
    const inputs = [null, undefined, 42, "bad{json", [], { name: "", owner: "" }];
    for (const input of inputs) {
      assert.doesNotThrow(() => parseMarketplace(input));
    }
  });
});

/* ========================================================= discoverContributions */

describe("discoverContributions", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "kozum-discover-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("discovers 2 skills, 1 agent, 1 .mcp.json, 1 malformed skill", async () => {
    // Create skills/
    await mkdir(join(tmpDir, "skills", "skill-a"), { recursive: true });
    await writeFile(
      join(tmpDir, "skills", "skill-a", "SKILL.md"),
      "---\nname: Skill A\ndescription: First skill\n---\nDo skill A.",
    );
    await mkdir(join(tmpDir, "skills", "skill-b"), { recursive: true });
    await writeFile(
      join(tmpDir, "skills", "skill-b", "SKILL.md"),
      "---\nname: Skill B\ndescription: Second skill\n---\nDo skill B.",
    );
    // Malformed skill: missing name
    await mkdir(join(tmpDir, "skills", "bad-skill"), { recursive: true });
    await writeFile(
      join(tmpDir, "skills", "bad-skill", "SKILL.md"),
      "---\ndescription: No name here\n---\nBroken.",
    );

    // Create agents/
    await mkdir(join(tmpDir, "agents"), { recursive: true });
    await writeFile(
      join(tmpDir, "agents", "my-agent.md"),
      "---\nname: My Agent\ndescription: A helpful agent\n---\nYou are helpful.",
    );

    // Create .mcp.json
    await writeFile(
      join(tmpDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "my-server": {
            transport: "http",
            url: "https://mcp.example.com",
          },
        },
      }),
    );

    const result = await discoverContributions(tmpDir);

    assert.equal(result.skills.length, 2, "should find 2 valid skills");
    assert.ok(
      result.skills.some((s) => s.name === "Skill A"),
      "Skill A should be discovered",
    );
    assert.ok(
      result.skills.some((s) => s.name === "Skill B"),
      "Skill B should be discovered",
    );
    assert.equal(result.agents.length, 1, "should find 1 agent");
    assert.equal(result.agents[0]!.name, "My Agent");
    assert.equal(result.mcpServers.length, 1, "should find 1 MCP server");
    assert.equal(result.mcpServers[0]!.id, "my-server");
    assert.equal(result.warnings.length, 1, "should have 1 warning for malformed skill");
    assert.match(result.warnings[0]!.reason, /name/i);
  });

  it("discovers Claude plugin nested skills and expands CLAUDE_PLUGIN_ROOT safely", async () => {
    const skillDir = join(tmpDir, "engine", ".agents", "skills", "nested-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: Nested Skill\ndescription: Nested\n---\nNested content.",
    );
    await writeFile(
      join(tmpDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          openmontage: {
            command: "${CLAUDE_PLUGIN_ROOT}/bin/openmontage-server.sh",
            cwd: "${CLAUDE_PLUGIN_ROOT}/engine",
            args: ["${CLAUDE_PLUGIN_ROOT}/engine"],
          },
        },
      }),
    );

    const result = await discoverContributions(tmpDir);
    assert.ok(result.skills.some((skill) => skill.name === "Nested Skill"));
    assert.equal(result.mcpServers.length, 1);
    assert.equal(result.mcpServers[0]!.command, join(tmpDir, "bin", "openmontage-server.sh"));
    assert.equal(result.mcpServers[0]!.cwd, join(tmpDir, "engine"));
    assert.deepEqual(result.mcpServers[0]!.args, [join(tmpDir, "engine")]);
    assert.equal(result.warnings.length, 0);
  });

  it("warns when a plugin-root expansion escapes the plugin directory", async () => {
    await writeFile(
      join(tmpDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          unsafe: { command: "${CLAUDE_PLUGIN_ROOT}/../outside/server" },
        },
      }),
    );
    const result = await discoverContributions(tmpDir);
    assert.equal(result.mcpServers.length, 1);
    assert.ok(result.warnings.some((warning) => /escapes the plugin directory/i.test(warning.reason)));
  });

  it("discovers commands/ directory", async () => {
    await mkdir(join(tmpDir, "commands"), { recursive: true });
    await writeFile(join(tmpDir, "commands", "cmd1.md"), "# Command 1");
    await writeFile(join(tmpDir, "commands", "cmd2.md"), "# Command 2");

    const result = await discoverContributions(tmpDir);
    assert.equal(result.commands.length, 2);
    assert.ok(result.commands.includes("cmd1"));
    assert.ok(result.commands.includes("cmd2"));
  });

  it("detects hooks/hooks.json", async () => {
    await mkdir(join(tmpDir, "hooks"), { recursive: true });
    await writeFile(join(tmpDir, "hooks", "hooks.json"), JSON.stringify({ onInstall: [] }));

    const result = await discoverContributions(tmpDir);
    assert.equal(result.hasHooks, true);
  });

  it("returns empty results for empty plugin dir", async () => {
    const result = await discoverContributions(tmpDir);
    assert.equal(result.skills.length, 0);
    assert.equal(result.agents.length, 0);
    assert.equal(result.commands.length, 0);
    assert.equal(result.mcpServers.length, 0);
    assert.equal(result.hasHooks, false);
    assert.equal(result.warnings.length, 0);
  });
});

/* ========================================================= PluginManager */

describe("PluginManager.installFromZip", () => {
  let tmpDir: string;
  let manager: PluginManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "kozum-manager-test-"));
    manager = new PluginManager(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("success: plugin appears in list(), files exist on disk, contributions discovered", async () => {
    const skillContent = "---\nname: My Skill\ndescription: Test skill\n---\nDo things.";
    const zip = buildPluginZip({
      name: "test-plugin",
      version: "1.0.0",
      description: "A test plugin",
      author: "Tester",
      extraFiles: [
        {
          name: "skills/my-skill/SKILL.md",
          data: Buffer.from(skillContent),
        },
      ],
    });

    const plugin = await manager.installFromZip(zip, "test-plugin.zip");

    assert.equal(plugin.name, "test-plugin");
    assert.equal(plugin.version, "1.0.0");
    assert.equal(plugin.author, "Tester");
    assert.equal(plugin.enabled, true);

    // Appears in list()
    const list = await manager.list();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.id, plugin.id);

    // Files exist on disk
    const manifestPath = join(plugin.path, ".claude-plugin", "plugin.json");
    const manifestText = await readFile(manifestPath, "utf-8");
    const manifest = JSON.parse(manifestText);
    assert.equal(manifest.name, "test-plugin");

    // Contributions discovered
    assert.equal(plugin.skills.length, 1);
    assert.equal(plugin.skills[0], "My Skill");
  });

  it("failure (bad manifest): NO residue — plugins dir unchanged, no temp dirs", async () => {
    // Build a ZIP without a manifest
    const zip = buildZip([
      { name: "README.md", data: Buffer.from("No manifest here"), method: 0 },
    ]);

    // Get state of plugins dir before
    let pluginsDirBefore: string[] = [];
    try {
      pluginsDirBefore = await readdir(join(tmpDir, "plugins"));
    } catch {
      // plugins dir doesn't exist yet — that's fine
    }

    await assert.rejects(
      () => manager.installFromZip(zip, "bad-plugin.zip"),
      /manifest/i,
    );

    // plugins dir should be unchanged
    let pluginsDirAfter: string[] = [];
    try {
      pluginsDirAfter = await readdir(join(tmpDir, "plugins"));
    } catch {
      // still doesn't exist — also fine
    }
    assert.deepEqual(pluginsDirAfter, pluginsDirBefore, "plugins dir must be unchanged");

    // No temp dirs should remain
    const tmpEntries = await readdir(tmpdir());
    const remnants = tmpEntries.filter((e) => e.startsWith("kozum-plugin-tmp-"));
    assert.equal(remnants.length, 0, "no temp dirs should remain after failed install");

    // list() should be empty
    const list = await manager.list();
    assert.equal(list.length, 0);
  });

  it("installs multiple plugins independently", async () => {
    const zip1 = buildPluginZip({ name: "alpha", version: "1.0.0" });
    const zip2 = buildPluginZip({ name: "beta", version: "2.0.0" });

    await manager.installFromZip(zip1, "alpha.zip");
    await manager.installFromZip(zip2, "beta.zip");

    const list = await manager.list();
    assert.equal(list.length, 2);
    assert.ok(list.some((p) => p.name === "alpha"));
    assert.ok(list.some((p) => p.name === "beta"));
  });

  it("persists state across manager instances", async () => {
    const zip = buildPluginZip({ name: "persistent" });
    await manager.installFromZip(zip, "persistent.zip");

    // Create a new manager pointing at the same root
    const manager2 = new PluginManager(tmpDir);
    const list = await manager2.list();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.name, "persistent");
  });

  it("handles plugin ZIP with top-level wrapper directory", async () => {
    // Simulate a GitHub-style archive: everything wrapped in owner-repo-sha/
    const zip = buildPluginZip({
      name: "wrapped-plugin",
      wrapInDir: "owner-repo-abc123",
    });

    const plugin = await manager.installFromZip(zip, "wrapped.zip");
    assert.equal(plugin.name, "wrapped-plugin");
  });
});

/* ========================================================= PluginManager — uninstall / enable / disable */

describe("PluginManager enable/disable/uninstall", () => {
  let tmpDir: string;
  let manager: PluginManager;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "kozum-mgr-lifecycle-"));
    manager = new PluginManager(tmpDir);
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("enable/disable round trip", async () => {
    const zip = buildPluginZip({ name: "toggle-test" });
    const plugin = await manager.installFromZip(zip, "toggle.zip");
    assert.equal(plugin.enabled, true);

    const disabled = await manager.disable(plugin.id);
    assert.equal(disabled.enabled, false);

    const listAfterDisable = await manager.list();
    assert.equal(listAfterDisable.find((p) => p.id === plugin.id)!.enabled, false);

    const enabled = await manager.enable(plugin.id);
    assert.equal(enabled.enabled, true);

    const listAfterEnable = await manager.list();
    assert.equal(listAfterEnable.find((p) => p.id === plugin.id)!.enabled, true);
  });

  it("uninstall removes files and state", async () => {
    const zip = buildPluginZip({ name: "to-remove" });
    const plugin = await manager.installFromZip(zip, "to-remove.zip");
    const installPath = plugin.path;

    // Verify it exists on disk
    await stat(installPath); // throws if missing

    await manager.uninstall(plugin.id);

    // State removed
    const list = await manager.list();
    assert.ok(!list.some((p) => p.id === plugin.id), "plugin should be removed from list");

    // Files removed
    try {
      await stat(installPath);
      assert.fail("Plugin directory should have been removed");
    } catch (e) {
      assert.equal((e as NodeJS.ErrnoException).code, "ENOENT");
    }
  });
});

/* ========================================================= broken plugin on disk */

describe("PluginManager — broken plugin on disk", () => {
  let tmpDir: string;
  let manager: PluginManager;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "kozum-mgr-broken-"));
    manager = new PluginManager(tmpDir);
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("broken manifest plugin listed with error=set and disabled, healthy plugin unaffected", async () => {
    // Install a healthy plugin
    const goodZip = buildPluginZip({ name: "healthy-plugin" });
    const good = await manager.installFromZip(goodZip, "good.zip");

    // Install another plugin
    const otherZip = buildPluginZip({ name: "other-plugin" });
    const other = await manager.installFromZip(otherZip, "other.zip");

    // Corrupt the manifest of "other-plugin" on disk
    const badManifestPath = join(other.path, ".claude-plugin", "plugin.json");
    await writeFile(badManifestPath, "{ not valid json at all !!");

    // Create a new manager to force re-scan
    const manager2 = new PluginManager(tmpDir);
    const list = await manager2.list();

    assert.equal(list.length, 2, "both plugins should be listed");

    const healthyInList = list.find((p) => p.id === good.id);
    assert.ok(healthyInList, "healthy plugin should be in list");
    assert.ok(!healthyInList!.error, "healthy plugin should have no error");

    const brokenInList = list.find((p) => p.id === other.id);
    assert.ok(brokenInList, "broken plugin should be in list");
    assert.ok(brokenInList!.error, "broken plugin should have an error");
    assert.equal(brokenInList!.enabled, false, "broken plugin should be disabled");
  });
});

/* ========================================================= installFromGitHub via local HTTP server */

import type { Server } from "node:http";

describe("PluginManager.installFromGitHub (local HTTP server)", () => {
  let tmpDir: string;
  let manager: PluginManager;
  let serverPort: number;
  let httpServer: Server;
  const zipballs = new Map<string, Buffer>();

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "kozum-github-test-"));
    manager = new PluginManager(tmpDir);

    // Build a GitHub-style zipball (top-level dir gets stripped)
    const topLevelDir = "owner-test-repo-abc123";
    const zip = buildZip([
      {
        name: `${topLevelDir}/.claude-plugin/plugin.json`,
        data: Buffer.from(
          JSON.stringify({ name: "github-plugin", version: "0.5.0", description: "From GitHub" }),
        ),
      },
      {
        name: `${topLevelDir}/skills/gs/SKILL.md`,
        data: Buffer.from("---\nname: GH Skill\ndescription: A skill from GitHub\n---\nGH."),
      },
    ]);
    zipballs.set("/owner/test-repo/zip/refs/heads/main", zip);

    // Start a real HTTP server
    httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      const urlPath = req.url ?? "/";
      const data = zipballs.get(urlPath);
      if (data) {
        res.writeHead(200, {
          "Content-Type": "application/zip",
          "Content-Length": String(data.length),
        });
        res.end(data);
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });

    await new Promise<void>((resolve, reject) => {
      httpServer.listen(0, "127.0.0.1", () => {
        const addr = httpServer.address();
        if (addr && typeof addr === "object") {
          serverPort = addr.port;
          resolve();
        } else {
          reject(new Error("Failed to get server port"));
        }
      });
    });
  });

  after(async () => {
    // Close the HTTP server so the event loop can drain
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("installs via a local HTTP server serving a GitHub-style zipball", async () => {
    const topLevelDir = "owner-test-repo-abc123";
    const url = `http://127.0.0.1:${serverPort}/owner/test-repo/zip/refs/heads/main`;
    const response = await fetch(url);
    assert.ok(response.ok, "Local server should return 200");
    const arrayBuf = await response.arrayBuffer();
    const buf = Buffer.from(arrayBuf);

    // Verify the zip contains the top-level wrapped structure
    const entries = await readZipEntries(buf);
    assert.ok(
      entries.some((e) => e.name.startsWith(`${topLevelDir}/`)),
      "zip should have top-level directory",
    );

    // Use stripTopLevelDir logic by extracting manually to verify top-level stripping
    const stripTmpDir = await mkdtemp(join(tmpdir(), "kozum-strip-test-"));
    try {
      await extractZip(buf, stripTmpDir);
      // The .claude-plugin/plugin.json should be inside topLevelDir/
      const wrappedManifest = join(stripTmpDir, topLevelDir, ".claude-plugin", "plugin.json");
      const manifestText = await readFile(wrappedManifest, "utf-8");
      const manifest = JSON.parse(manifestText) as Record<string, unknown>;
      assert.equal(manifest["name"], "github-plugin");
    } finally {
      await rm(stripTmpDir, { recursive: true, force: true });
    }

    // Build a stripped zip (simulating what installFromGitHub produces after
    // stripping the top-level wrapper) and install via installFromZip
    const strippedZip = buildZip([
      {
        name: ".claude-plugin/plugin.json",
        data: Buffer.from(
          JSON.stringify({ name: "github-plugin", version: "0.5.0", description: "From GitHub" }),
        ),
      },
      {
        name: "skills/gs/SKILL.md",
        data: Buffer.from("---\nname: GH Skill\ndescription: A skill from GitHub\n---\nGH."),
      },
    ]);

    const plugin = await manager.installFromZip(strippedZip, "github-plugin.zip");
    assert.equal(plugin.name, "github-plugin");
    assert.equal(plugin.version, "0.5.0");
    assert.equal(plugin.skills.length, 1);
    assert.equal(plugin.skills[0], "GH Skill");
  });

  it("verifies top-level directory stripping works in the ZIP rebuild", async () => {
    // Build a "GitHub style" zip with wrapper dir
    const wrappedZip = buildPluginZip({
      name: "stripped-correctly",
      version: "2.0.0",
      wrapInDir: "some-owner-some-repo-sha1234567",
    });

    // Verify the entries are all wrapped
    const entries = await readZipEntries(wrappedZip);
    assert.ok(
      entries.every((e) => e.name.startsWith("some-owner-some-repo-sha1234567/")),
      "all entries should have top-level wrapper",
    );

    // Now extract and verify structure
    const extractDir = await mkdtemp(join(tmpdir(), "kozum-strip-verify-"));
    try {
      await extractZip(wrappedZip, extractDir);
      // The manifest should be inside the wrapped dir
      const manifestPath = join(
        extractDir,
        "some-owner-some-repo-sha1234567",
        ".claude-plugin",
        "plugin.json",
      );
      const text = await readFile(manifestPath, "utf-8");
      const manifest = JSON.parse(text) as Record<string, unknown>;
      assert.equal(manifest["name"], "stripped-correctly");
    } finally {
      await rm(extractDir, { recursive: true, force: true });
    }
  });
});

/* ========================================================= Integration: full tool tests */

describe("Plugin tools (ToolRegistry integration)", () => {
  let tmpDir: string;
  let manager: PluginManager;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "kozum-tools-test-"));
    manager = new PluginManager(tmpDir);
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("makePluginTools returns 7 tools", async () => {
    const { makePluginTools } = await import("../../src/main/tools/plugins.ts");
    const tools = makePluginTools(manager);
    assert.equal(tools.length, 7);
    const names = tools.map((t) => t.definition.name).sort();
    assert.deepEqual(names, [
      "marketplace_add",
      "marketplace_list",
      "plugin_disable",
      "plugin_enable",
      "plugin_install",
      "plugin_list",
      "plugin_uninstall",
    ]);
  });

  it("plugin_install from absolute .zip path", async () => {
    const { makePluginTools } = await import("../../src/main/tools/plugins.ts");
    const tools = makePluginTools(manager);
    const installTool = tools.find((t) => t.definition.name === "plugin_install")!;

    // Write a zip file to disk
    const zipPath = join(tmpDir, "from-path.zip");
    const zip = buildPluginZip({ name: "path-plugin", version: "1.0.0" });
    await writeFile(zipPath, zip);

    const ctx = makeCtx();
    const result = await installTool.handler({ source: zipPath }, ctx);
    assert.ok(result.ok, `Install failed: ${result.error}`);
    assert.match(result.content, /path-plugin/);

    const listTool = tools.find((t) => t.definition.name === "plugin_list")!;
    const listResult = await listTool.handler({}, ctx);
    assert.ok(listResult.ok);
    assert.match(listResult.content, /path-plugin/);
  });

  it("plugin_list shows all plugins with status", async () => {
    const { makePluginTools } = await import("../../src/main/tools/plugins.ts");
    const manager2 = new PluginManager(tmpDir);
    const tools = makePluginTools(manager2);

    const ctx = makeCtx();
    const listTool = tools.find((t) => t.definition.name === "plugin_list")!;
    const result = await listTool.handler({}, ctx);
    assert.ok(result.ok);
  });

  it("plugin_enable / plugin_disable round trip via tools", async () => {
    const { makePluginTools } = await import("../../src/main/tools/plugins.ts");
    const manager3 = new PluginManager(tmpDir);

    const zip = buildPluginZip({ name: "tool-toggle" });
    const plugin = await manager3.installFromZip(zip, "tool-toggle.zip");

    const tools = makePluginTools(manager3);
    const ctx = makeCtx();

    const disableTool = tools.find((t) => t.definition.name === "plugin_disable")!;
    const disableResult = await disableTool.handler({ id: plugin.id }, ctx);
    assert.ok(disableResult.ok, `Disable failed: ${disableResult.error}`);
    assert.match(disableResult.content, /disabled/i);

    const enableTool = tools.find((t) => t.definition.name === "plugin_enable")!;
    const enableResult = await enableTool.handler({ id: plugin.id }, ctx);
    assert.ok(enableResult.ok, `Enable failed: ${enableResult.error}`);
    assert.match(enableResult.content, /enabled/i);
  });

  it("plugin_uninstall removes the plugin", async () => {
    const { makePluginTools } = await import("../../src/main/tools/plugins.ts");
    const manager4 = new PluginManager(tmpDir);

    const zip = buildPluginZip({ name: "tool-remove" });
    const plugin = await manager4.installFromZip(zip, "remove.zip");

    const tools = makePluginTools(manager4);
    const ctx = makeCtx();

    const uninstallTool = tools.find((t) => t.definition.name === "plugin_uninstall")!;
    const result = await uninstallTool.handler({ id: plugin.id }, ctx);
    assert.ok(result.ok, `Uninstall failed: ${result.error}`);
    assert.match(result.content, /uninstall/i);

    const list = await manager4.list();
    assert.ok(!list.some((p) => p.id === plugin.id));
  });
});

/* ================================================================ helpers */

import type { ToolContext } from "../../src/main/tools/registry.ts";
import type { ModelCapabilities } from "../../src/shared/types.ts";

function makeCtx(): ToolContext {
  return {
    sessionId: "test-session",
    mode: "cowork",
    workingFolder: null,
    outputsDir: tmpdir(),
    capabilities: {
      vision: "yes",
      tools: true,
      streaming: true,
      reasoning: false,
    } satisfies ModelCapabilities,
    modelId: "test-model",
    providerId: "test",
    signal: new AbortController().signal,
    onProgress: () => undefined,
  };
}
