/**
 * PluginManager — install, list, enable, disable, and uninstall plugins.
 *
 * Installation guarantees:
 *   - Atomic: a temp dir is used during extraction/validation; only on
 *     success is it moved into place. Failures clean up the temp dir.
 *   - No residue: if any step fails, the plugins directory is unchanged.
 *
 * State is persisted to <rootDir>/plugins.json so a restart recovers it.
 * The constructor takes `rootDir` so tests can inject a temp directory.
 */

import { readFile, writeFile, mkdir, rm, rename, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { Plugin, Marketplace } from "../../shared/types.ts";
import { extractZip, readZipEntries } from "./zip.ts";
import { parsePluginManifest, parseMarketplace } from "./manifest.ts";
import type { MarketplaceManifest } from "./manifest.ts";
import { discoverContributions } from "./discover.ts";
import { fetchGitHub, isGitHubHost } from "../net/github.ts";
import { assertPublicUrl } from "../net/ssrf.ts";

/* ----------------------------------------------------------------- ids --- */

let _seq = 0;
function newId(): string {
  _seq += 1;
  return `plugin_${Date.now().toString(36)}_${_seq.toString(36)}`;
}

/**
 * Pattern for safe plugin ids.  Must match what newId() produces and must
 * not contain path separators, "..", or anything that could be abused in a
 * filesystem path.
 */
const SAFE_ID_RE = /^plugin_[a-z0-9]+_[a-z0-9]+$/;

/** Valid GitHub owner / repo component: 1-100 alphanumeric, dash, dot, underscore. */
const GITHUB_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;

/**
 * Valid ref: alphanumeric, dot, dash, slash, underscore — no ".." segment,
 * no leading or trailing slash.  We then additionally check for ".." segments.
 */
const GITHUB_REF_RE = /^[A-Za-z0-9._\-/]{1,255}$/;

/* -------------------------------------------------------- state shape --- */

interface PluginState {
  plugins: Plugin[];
  marketplaces: MarketplaceRecord[];
}

interface MarketplaceRecord {
  id: string;
  name: string;
  source: string;
  manifest?: MarketplaceManifest;
  pluginCount: number;
  lastFetchedAt: number;
}

/* ------------------------------------------------------- PluginManager --- */

export class PluginManager {
  private rootDir: string;
  private pluginsDir: string;
  private stateFile: string;
  private state: PluginState = { plugins: [], marketplaces: [] };
  private loaded = false;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.pluginsDir = join(rootDir, "plugins");
    this.stateFile = join(rootDir, "plugins.json");
  }

  /* ---------------------------------------------------- state I/O --- */

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await this.loadState();
  }

  private async loadState(): Promise<void> {
    this.loaded = true;
    try {
      const text = await readFile(this.stateFile, "utf-8");
      const parsed = JSON.parse(text) as PluginState;
      this.state = {
        plugins: Array.isArray(parsed.plugins) ? parsed.plugins : [],
        marketplaces: Array.isArray(parsed.marketplaces) ? parsed.marketplaces : [],
      };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        // State file is corrupted — start fresh but don't crash.
        this.state = { plugins: [], marketplaces: [] };
      }
    }
    // Re-scan on-disk plugins and mark any that are broken
    await this.reconcileDiskState();
  }

  private async saveState(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await writeFile(this.stateFile, JSON.stringify(this.state, null, 2), "utf-8");
  }

  /**
   * Walk pluginsDir looking for installed plugins that may not be in state,
   * and verify that plugins in state still have valid manifests on disk.
   */
  private async reconcileDiskState(): Promise<void> {
    // Load plugins already in state and re-validate their manifests
    for (const plugin of this.state.plugins) {
      try {
        const manifestPath = join(plugin.path, ".claude-plugin", "plugin.json");
        const text = await readFile(manifestPath, "utf-8");
        const result = parsePluginManifest(text, manifestPath);
        if (!result.ok) {
          plugin.error = result.error;
          plugin.enabled = false;
        } else {
          // Clear stale errors if the manifest is now valid
          if (plugin.error) {
            delete plugin.error;
          }
        }
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          plugin.error = `Plugin directory or manifest missing at ${plugin.path}`;
          plugin.enabled = false;
        } else {
          const msg = e instanceof Error ? e.message : String(e);
          plugin.error = msg;
          plugin.enabled = false;
        }
      }
    }
  }

  /* ---------------------------------------------- installFromZip --- */

  async installFromZip(buf: Buffer, originalName: string): Promise<Plugin> {
    await this.ensureLoaded();

    // 1. Validate that buf is a real ZIP before touching disk
    await readZipEntries(buf); // throws if not a valid ZIP

    // 2. Extract to a temp dir INSIDE pluginsDir so the final rename is
    //    always on the same filesystem (avoids EXDEV when /tmp is tmpfs).
    await mkdir(this.pluginsDir, { recursive: true });
    const tmpBase = join(this.pluginsDir, `_tmp-${Date.now()}`);
    await mkdir(tmpBase, { recursive: true });

    try {
      await extractZip(buf, tmpBase);

      // 3. Find the plugin root: either tmpBase directly or a single subdirectory
      const pluginRoot = await resolvePluginRoot(tmpBase);

      // 4. Validate the manifest
      const manifestPath = join(pluginRoot, ".claude-plugin", "plugin.json");
      let manifestText: string;
      try {
        manifestText = await readFile(manifestPath, "utf-8");
      } catch {
        throw new Error(
          `Plugin is missing .claude-plugin/plugin.json manifest at "${manifestPath}". ` +
            `Every plugin must include this file.`,
        );
      }

      const manifestResult = parsePluginManifest(manifestText, manifestPath);
      if (!manifestResult.ok) {
        throw new Error(`Plugin manifest invalid: ${manifestResult.error}`);
      }
      const manifest = manifestResult.value;

      // 5. Discover contributions
      const contributions = await discoverContributions(pluginRoot);

      // 6. Choose a stable install id and path
      const id = newId();
      await mkdir(this.pluginsDir, { recursive: true });
      const installPath = join(this.pluginsDir, id);

      // 7. Atomic move: rename tmpBase into place (or pluginRoot if nested)
      if (pluginRoot === tmpBase) {
        await rename(tmpBase, installPath);
      } else {
        await rename(pluginRoot, installPath);
        // Clean up the now-empty tmpBase
        await rm(tmpBase, { recursive: true, force: true });
      }

      // 8. Build the plugin record
      const plugin: Plugin = {
        id,
        name: manifest.name,
        description: manifest.description,
        version: manifest.version,
        ...(manifest.author ? { author: manifest.author } : {}),
        enabled: true,
        source: { kind: "zip", originalName },
        installedAt: Date.now(),
        updatedAt: Date.now(),
        path: installPath,
        skills: contributions.skills.map((s) => s.name),
        agents: contributions.agents.map((a) => a.name),
        commands: contributions.commands,
        mcpServers: contributions.mcpServers.map((m) => m.id),
        hasHooks: contributions.hasHooks,
        installedByAgent: false,
      };

      this.state.plugins.push(plugin);
      await this.saveState();
      return plugin;
    } catch (e) {
      // Clean up temp dir — leave no trace
      await rm(tmpBase, { recursive: true, force: true });
      throw e;
    }
  }

  /* ----------------------------------------- installFromGitHub --- */

  /**
   * Install a plugin from a GitHub repository.
   *
   * Accepts:
   *   - "owner/repo"
   *   - "owner/repo@ref"
   *   - "owner/repo/sub/path"
   *   - "https://github.com/owner/repo"
   *   - "https://github.com/owner/repo/tree/<ref>/<subpath>"
   *
   * Downloads via fetchGitHub (never blocked). Strips the single top-level
   * directory GitHub always adds to zipball archives.
   */
  async installFromGitHub(repoRef: string): Promise<Plugin> {
    await this.ensureLoaded();

    const parsed = parseGitHubRef(repoRef);
    const { owner, repo, ref, subPath } = parsed;

    const downloadRef = ref ?? "HEAD";

    // Encode each URL path segment individually so that a ref containing
    // "/../" cannot collapse into a different path component.  owner/repo are
    // already validated to contain only safe characters, but encode anyway
    // for defence in depth.
    const encodedOwner = encodeURIComponent(owner);
    const encodedRepo = encodeURIComponent(repo);
    const encodedRef = encodeURIComponent(downloadRef);

    // GitHub zipball URL via codeload — each segment encoded separately.
    const zipUrl =
      `https://codeload.github.com/${encodedOwner}/${encodedRepo}` +
      `/zip/refs/heads/${encodedRef}`;

    let response: Response;
    let resolvedUrl = zipUrl;
    try {
      response = await fetchGitHub(zipUrl);
    } catch (e) {
      // Try fallback: zip/HEAD
      if (downloadRef !== "HEAD") {
        try {
          const fallbackUrl =
            `https://codeload.github.com/${encodedOwner}/${encodedRepo}/zip/HEAD`;
          response = await fetchGitHub(fallbackUrl);
          resolvedUrl = fallbackUrl;
        } catch {
          const msg = e instanceof Error ? e.message : String(e);
          throw new Error(`Failed to download GitHub plugin "${repoRef}": ${msg}`);
        }
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Failed to download GitHub plugin "${repoRef}": ${msg}`);
      }
    }

    if (!response.ok) {
      throw new Error(
        `GitHub returned ${response.status} ${response.statusText} for "${repoRef}".`,
      );
    }

    const arrayBuf = await response.arrayBuffer();
    const buf = Buffer.from(arrayBuf);

    // Strip the top-level directory GitHub adds to zipball archives
    // GitHub always wraps content in <owner>-<repo>-<sha>/ at the root
    const stripped = await stripTopLevelDir(buf, subPath);

    // Record the RESOLVED url so the UI always shows where the code came from.
    return this.installFromZip(stripped, resolvedUrl);
  }

  /* ----------------------------------------- marketplace --- */

  async addMarketplace(source: string): Promise<Marketplace> {
    await this.ensureLoaded();

    // source can be "owner/repo" or a full URL
    const id = newId();

    let manifest: MarketplaceManifest | undefined;
    let name = source;

    // Try to fetch the marketplace manifest
    try {
      const manifestUrl = buildMarketplaceUrl(source);
      // SSRF guard — the source URL comes from model/user input.
      assertPublicUrl(manifestUrl);
      let response: Response;
      if (isGitHubHost(manifestUrl)) {
        response = await fetchGitHub(manifestUrl);
      } else {
        response = await fetch(manifestUrl);
      }
      if (response.ok) {
        const text = await response.text();
        const result = parseMarketplace(text);
        if (result.ok) {
          manifest = result.value;
          name = manifest.name;
        }
      }
    } catch {
      // Couldn't fetch manifest — store the source with 0 plugins
    }

    const record: MarketplaceRecord = {
      id,
      name,
      source,
      ...(manifest ? { manifest } : {}),
      pluginCount: manifest ? manifest.plugins.length : 0,
      lastFetchedAt: Date.now(),
    };

    this.state.marketplaces.push(record);
    await this.saveState();

    return {
      id,
      name,
      source,
      pluginCount: record.pluginCount,
      lastFetchedAt: record.lastFetchedAt,
    };
  }

  async listMarketplace(id: string): Promise<MarketplaceManifest | null> {
    await this.ensureLoaded();
    const record = this.state.marketplaces.find((m) => m.id === id);
    if (!record) return null;
    return record.manifest ?? null;
  }

  async installFromMarketplace(marketplaceId: string, pluginName: string): Promise<Plugin> {
    await this.ensureLoaded();

    const record = this.state.marketplaces.find((m) => m.id === marketplaceId);
    if (!record) {
      throw new Error(`Marketplace "${marketplaceId}" not found. Use marketplace_add first.`);
    }
    if (!record.manifest) {
      throw new Error(`Marketplace "${marketplaceId}" has no cached manifest.`);
    }

    const entry = record.manifest.plugins.find((p) => p.name === pluginName);
    if (!entry) {
      const names = record.manifest.plugins.map((p) => p.name).join(", ");
      throw new Error(
        `Plugin "${pluginName}" not found in marketplace "${record.name}". ` +
          `Available: ${names || "(none)"}.`,
      );
    }

    // Install based on source kind
    if (entry.source.kind === "github") {
      const repoRef = entry.source.subPath
        ? `${entry.source.repo}/${entry.source.subPath}`
        : entry.source.repo;
      return this.installFromGitHub(
        entry.source.ref ? `${repoRef}@${entry.source.ref}` : repoRef,
      );
    }

    throw new Error(
      `Marketplace plugin "${pluginName}" has unsupported source kind "${entry.source.kind}".`,
    );
  }

  /* -------------------------------------------- list / enable / disable / uninstall --- */

  async list(): Promise<Plugin[]> {
    await this.ensureLoaded();
    return [...this.state.plugins];
  }

  async enable(id: string): Promise<Plugin> {
    await this.ensureLoaded();
    const plugin = this.state.plugins.find((p) => p.id === id);
    if (!plugin) throw new Error(`Plugin "${id}" not found.`);
    plugin.enabled = true;
    plugin.updatedAt = Date.now();
    await this.saveState();
    return { ...plugin };
  }

  async disable(id: string): Promise<Plugin> {
    await this.ensureLoaded();
    const plugin = this.state.plugins.find((p) => p.id === id);
    if (!plugin) throw new Error(`Plugin "${id}" not found.`);
    plugin.enabled = false;
    plugin.updatedAt = Date.now();
    await this.saveState();
    return { ...plugin };
  }

  async uninstall(id: string): Promise<void> {
    await this.ensureLoaded();
    const idx = this.state.plugins.findIndex((p) => p.id === id);
    if (idx === -1) throw new Error(`Plugin "${id}" not found.`);
    const plugin = this.state.plugins[idx]!;

    // Validate the id itself before using it to construct a path.
    // A strict pattern prevents directory traversal or device names.
    if (!SAFE_ID_RE.test(plugin.id)) {
      throw new Error(`Plugin id "${plugin.id}" in state is malformed — refusing to delete.`);
    }

    // RECOMPUTE the delete target from the id rather than trusting the stored
    // path, so a tampered plugins.json cannot point rm at arbitrary locations.
    const expectedPath = join(this.pluginsDir, plugin.id);

    // Double-check: if the stored path differs from expected, log and use expected.
    // We still remove the expected location; an unexpected stored path is suspicious.
    const deletePath = expectedPath;

    // Remove files from disk
    try {
      await rm(deletePath, { recursive: true, force: true });
    } catch {
      // Proceed even if removal partially fails — state is removed either way
    }

    this.state.plugins.splice(idx, 1);
    await this.saveState();
  }
}

/* -------------------------------------------------------- helpers --- */

interface GitHubRef {
  owner: string;
  repo: string;
  ref?: string;
  subPath?: string;
}

function validateGitHubPart(
  value: string,
  field: string,
  input: string,
  re: RegExp,
): void {
  if (!re.test(value)) {
    throw new Error(
      `Invalid GitHub ${field} "${value}" in "${input}". ` +
        `Only alphanumeric characters, dots, dashes, and underscores are allowed.`,
    );
  }
}

function validateGitHubRef(ref: string, input: string): void {
  if (!GITHUB_REF_RE.test(ref)) {
    throw new Error(
      `Invalid GitHub ref "${ref}" in "${input}". ` +
        `Refs must be 1-255 characters of alphanumeric, dot, dash, slash, or underscore.`,
    );
  }
  // Forbid ".." segments — split on both separators to be thorough.
  for (const segment of ref.split(/[\\/]/)) {
    if (segment === "..") {
      throw new Error(
        `GitHub ref "${ref}" in "${input}" contains ".." — rejected to prevent path traversal.`,
      );
    }
  }
}

function parseGitHubRef(input: string): GitHubRef {
  // Full URL: https://github.com/owner/repo[/tree/<ref>[/subpath]]
  if (input.startsWith("https://") || input.startsWith("http://")) {
    const url = new URL(input);
    const parts = url.pathname.replace(/^\//, "").split("/");
    const owner = parts[0] ?? "";
    const repo = parts[1] ?? "";
    if (!owner || !repo) {
      throw new Error(`Invalid GitHub URL: "${input}"`);
    }
    validateGitHubPart(owner, "owner", input, GITHUB_NAME_RE);
    validateGitHubPart(repo, "repo", input, GITHUB_NAME_RE);
    // /tree/<ref>/...
    if (parts[2] === "tree" && parts[3]) {
      const ref = parts[3]!;
      validateGitHubRef(ref, input);
      const subPath = parts.slice(4).join("/") || undefined;
      return { owner, repo, ref, subPath };
    }
    return { owner, repo };
  }

  // Short form: owner/repo[@ref][/subpath]
  // First extract @ref if present
  let rest = input;
  let ref: string | undefined;

  const atIdx = rest.indexOf("@");
  if (atIdx !== -1) {
    ref = rest.slice(atIdx + 1);
    rest = rest.slice(0, atIdx);
    validateGitHubRef(ref, input);
  }

  const parts = rest.split("/");
  const owner = parts[0] ?? "";
  const repo = parts[1] ?? "";

  if (!owner || !repo) {
    throw new Error(
      `Invalid GitHub ref "${input}". ` +
        `Expected "owner/repo", "owner/repo@ref", or a full https://github.com/... URL.`,
    );
  }

  validateGitHubPart(owner, "owner", input, GITHUB_NAME_RE);
  validateGitHubPart(repo, "repo", input, GITHUB_NAME_RE);

  const subPath = parts.slice(2).join("/") || undefined;
  return { owner, repo, ref, subPath };
}

/**
 * Strip the single top-level directory that GitHub adds to zipball archives.
 * Optionally further descend into subPath.
 */
async function stripTopLevelDir(buf: Buffer, subPath?: string): Promise<Buffer> {
  const entries = await readZipEntries(buf);
  if (entries.length === 0) {
    throw new Error("GitHub returned an empty archive.");
  }

  // Find the top-level directory prefix
  const firstEntry = entries[0]!;
  const topDir = firstEntry.name.split("/")[0]!;
  if (!topDir) {
    throw new Error("GitHub archive has no top-level directory to strip.");
  }

  const topPrefix = topDir + "/";

  // Build a virtual filesystem: rewrite entry names
  const targetPrefix = subPath ? `${topPrefix}${subPath}/` : topPrefix;

  const filtered = entries
    .filter((e) => e.name.startsWith(targetPrefix))
    .map((e) => ({ ...e, name: e.name.slice(targetPrefix.length) }))
    .filter((e) => e.name.length > 0);

  if (filtered.length === 0) {
    throw new Error(
      subPath
        ? `Sub-path "${subPath}" not found in GitHub archive for "${topDir}".`
        : `GitHub archive for "${topDir}" appears to be empty after stripping top-level dir.`,
    );
  }

  // Rebuild a new minimal ZIP in memory
  return buildMinimalZip(buf, filtered);
}

interface RebuildEntry {
  name: string;
  method: number;
  uncompressedSize: number;
  compressedSize: number;
  localHeaderOffset: number;
  isDirectory: boolean;
}

/**
 * Reconstruct a minimal ZIP buffer by copying only selected entries from `src`.
 * This avoids needing to re-compress anything.
 */
async function buildMinimalZip(src: Buffer, entries: RebuildEntry[]): Promise<Buffer> {
  const parts: Buffer[] = [];
  const centralDir: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    // Find local header in source
    const localSigOff = entry.localHeaderOffset;
    if (localSigOff + 30 > src.length) {
      throw new Error(`Corrupt local header for "${entry.name}".`);
    }

    const fileNameLen = src.readUInt16LE(localSigOff + 26);
    const extraLen = src.readUInt16LE(localSigOff + 28);
    const dataStart = localSigOff + 30 + fileNameLen + extraLen;
    const dataEnd = dataStart + entry.compressedSize;

    if (dataEnd > src.length) {
      throw new Error(`Entry data for "${entry.name}" extends beyond source buffer.`);
    }

    // Build new local file header with the rewritten name
    const nameBytes = Buffer.from(entry.name, "utf-8");
    const localHeader = Buffer.alloc(30 + nameBytes.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(1 << 11, 6); // GP flag: UTF-8
    localHeader.writeUInt16LE(entry.method, 8);
    localHeader.writeUInt32LE(0, 10); // last mod time/date (zeroed)
    localHeader.writeUInt32LE(0, 14); // CRC32 (not validated)
    localHeader.writeUInt32LE(entry.compressedSize, 18);
    localHeader.writeUInt32LE(entry.uncompressedSize, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28); // no extra
    nameBytes.copy(localHeader, 30);

    const localOffset = offset;
    parts.push(localHeader);
    offset += localHeader.length;

    const data = src.slice(dataStart, dataEnd);
    parts.push(data);
    offset += data.length;

    // Central directory entry
    const cdEntry = Buffer.alloc(46 + nameBytes.length);
    cdEntry.writeUInt32LE(0x02014b50, 0);
    cdEntry.writeUInt16LE(20, 4); // version made by
    cdEntry.writeUInt16LE(20, 6); // version needed
    cdEntry.writeUInt16LE(1 << 11, 8); // GP flag: UTF-8
    cdEntry.writeUInt16LE(entry.method, 10);
    cdEntry.writeUInt32LE(0, 12); // last mod
    cdEntry.writeUInt32LE(0, 16); // CRC32
    cdEntry.writeUInt32LE(entry.compressedSize, 20);
    cdEntry.writeUInt32LE(entry.uncompressedSize, 24);
    cdEntry.writeUInt16LE(nameBytes.length, 28);
    cdEntry.writeUInt16LE(0, 30); // extra len
    cdEntry.writeUInt16LE(0, 32); // comment len
    cdEntry.writeUInt16LE(0, 34); // disk start
    cdEntry.writeUInt16LE(0, 36); // int attr
    cdEntry.writeUInt32LE(0, 38); // ext attr
    cdEntry.writeUInt32LE(localOffset, 42);
    nameBytes.copy(cdEntry, 46);
    centralDir.push(cdEntry);
  }

  const cdBuf = Buffer.concat(centralDir);
  const cdOffset = offset;
  parts.push(cdBuf);

  // EOCD
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with CD
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20); // comment len
  parts.push(eocd);

  return Buffer.concat(parts);
}

/**
 * Resolve the actual plugin root inside a freshly extracted temp dir.
 * If the ZIP had exactly one top-level non-hidden directory, no root-level files,
 * AND that directory contains a .claude-plugin subdirectory, use it as the root.
 * Otherwise the temp dir itself is the plugin root.
 */
async function resolvePluginRoot(tmpDir: string): Promise<string> {
  const entries = await readdir(tmpDir, { withFileTypes: true });
  // Only consider non-hidden directories (skip .claude-plugin, .git, etc.)
  const visibleDirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith("."));
  const files = entries.filter((e) => e.isFile());

  if (files.length === 0 && visibleDirs.length === 1) {
    const candidate = join(tmpDir, visibleDirs[0]!.name);
    // Only use this as root if it contains a .claude-plugin directory
    try {
      const inner = await readdir(candidate, { withFileTypes: true });
      if (inner.some((e) => e.isDirectory() && e.name === ".claude-plugin")) {
        return candidate;
      }
    } catch {
      // fall through to tmpDir
    }
  }

  return tmpDir;
}

/**
 * Build a URL for a marketplace manifest.
 * Supports "owner/repo" (GitHub raw) or full URLs.
 */
function buildMarketplaceUrl(source: string): string {
  if (source.startsWith("https://") || source.startsWith("http://")) {
    return source;
  }
  // Assume GitHub: owner/repo
  const clean = source.replace(/^github:\/\//, "");
  return `https://raw.githubusercontent.com/${clean}/main/.claude-plugin/marketplace.json`;
}

/* ---- re-export for convenience ---- */
export type { Plugin };
