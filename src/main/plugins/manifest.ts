/**
 * Plugin manifest parsers.
 *
 * parsePluginManifest — reads .claude-plugin/plugin.json
 * parseMarketplace    — reads .claude-plugin/marketplace.json
 *
 * Neither function throws on malformed input; both return typed results with
 * precise error messages so the caller can record them and continue.
 */

import type { PluginSource } from "../../shared/types.ts";

/* ---------------------------------------------------------- result type --- */

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/* --------------------------------------------------------- plugin.json --- */

export interface PluginManifest {
  /** Required: display name. */
  name: string;
  description: string;
  version: string;
  author?: string;
}

/**
 * Parse a .claude-plugin/plugin.json manifest.
 *
 * @param json  The raw JSON value (already parsed, or a string to be parsed).
 * @param path  Source path for error messages.
 */
export function parsePluginManifest(
  json: unknown,
  path: string,
): ParseResult<PluginManifest> {
  // Accept either pre-parsed or a JSON string
  let data: unknown = json;
  if (typeof json === "string") {
    try {
      data = JSON.parse(json);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `${path}: invalid JSON — ${msg}` };
    }
  }

  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return {
      ok: false,
      error: `${path}: plugin.json must be a JSON object, got ${Array.isArray(data) ? "array" : typeof data}.`,
    };
  }

  const obj = data as Record<string, unknown>;

  // name is required
  if (!("name" in obj) || typeof obj["name"] !== "string" || !obj["name"].trim()) {
    return {
      ok: false,
      error: `${path}: plugin.json is missing required field "name" (must be a non-empty string).`,
    };
  }

  const name = (obj["name"] as string).trim();
  const description = typeof obj["description"] === "string" ? obj["description"].trim() : "";
  const version = typeof obj["version"] === "string" ? obj["version"].trim() : "0.0.0";
  const author = typeof obj["author"] === "string" ? obj["author"].trim() : undefined;

  return {
    ok: true,
    value: {
      name,
      description,
      version,
      ...(author ? { author } : {}),
    },
  };
}

/* ------------------------------------------------------ marketplace.json --- */

export interface MarketplacePlugin {
  name: string;
  source: PluginSource;
  description: string;
  version?: string;
  category?: string;
  tags?: string[];
}

export interface MarketplaceManifest {
  name: string;
  owner: string;
  metadata?: Record<string, unknown>;
  plugins: MarketplacePlugin[];
}

/**
 * Parse a .claude-plugin/marketplace.json manifest.
 *
 * @param json  The raw JSON value (already parsed, or a string to be parsed).
 */
export function parseMarketplace(json: unknown): ParseResult<MarketplaceManifest> {
  let data: unknown = json;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `marketplace.json: invalid JSON — ${msg}` };
    }
  }

  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return {
      ok: false,
      error: `marketplace.json: must be a JSON object, got ${Array.isArray(data) ? "array" : typeof data}.`,
    };
  }

  const obj = data as Record<string, unknown>;

  if (typeof obj["name"] !== "string" || !obj["name"].trim()) {
    return {
      ok: false,
      error: `marketplace.json: missing required field "name".`,
    };
  }
  if (typeof obj["owner"] !== "string" || !obj["owner"].trim()) {
    return {
      ok: false,
      error: `marketplace.json: missing required field "owner".`,
    };
  }

  const name = (obj["name"] as string).trim();
  const owner = (obj["owner"] as string).trim();
  const metadata =
    obj["metadata"] !== null && typeof obj["metadata"] === "object" && !Array.isArray(obj["metadata"])
      ? (obj["metadata"] as Record<string, unknown>)
      : undefined;

  const rawPlugins = obj["plugins"];
  if (!Array.isArray(rawPlugins)) {
    return {
      ok: false,
      error: `marketplace.json: "plugins" field must be an array, got ${typeof rawPlugins}.`,
    };
  }

  const plugins: MarketplacePlugin[] = [];
  for (let i = 0; i < rawPlugins.length; i++) {
    const p = rawPlugins[i];
    if (p === null || typeof p !== "object" || Array.isArray(p)) {
      return {
        ok: false,
        error: `marketplace.json: plugins[${i}] must be an object.`,
      };
    }
    const pe = p as Record<string, unknown>;

    if (typeof pe["name"] !== "string" || !pe["name"].trim()) {
      return {
        ok: false,
        error: `marketplace.json: plugins[${i}] is missing required field "name".`,
      };
    }

    const pluginName = (pe["name"] as string).trim();
    const description =
      typeof pe["description"] === "string" ? pe["description"].trim() : "";
    const version =
      typeof pe["version"] === "string" ? pe["version"].trim() : undefined;
    const category =
      typeof pe["category"] === "string" ? pe["category"].trim() : undefined;

    let tags: string[] | undefined;
    if (Array.isArray(pe["tags"])) {
      tags = pe["tags"].filter((t) => typeof t === "string").map((t) => (t as string).trim());
    }

    // Parse source from the plugin entry
    const source = parsePluginSource(pe["source"], pluginName);

    plugins.push({
      name: pluginName,
      source,
      description,
      ...(version ? { version } : {}),
      ...(category ? { category } : {}),
      ...(tags ? { tags } : {}),
    });
  }

  return {
    ok: true,
    value: {
      name,
      owner,
      ...(metadata ? { metadata } : {}),
      plugins,
    },
  };
}

/* ------------------------------------------ source parsing helper --- */

function parsePluginSource(raw: unknown, pluginName: string): PluginSource {
  if (raw === null || raw === undefined) {
    // Default: treat it as a GitHub source with plugin name as repo
    return { kind: "github", repo: pluginName };
  }
  if (typeof raw === "string") {
    if (raw.startsWith("https://github.com/") || raw.includes("/")) {
      return { kind: "github", repo: raw };
    }
    return { kind: "github", repo: raw };
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const kind = typeof obj["kind"] === "string" ? obj["kind"] : "github";
    if (kind === "zip") {
      return {
        kind: "zip",
        originalName: typeof obj["originalName"] === "string" ? obj["originalName"] : pluginName,
      };
    }
    if (kind === "marketplace") {
      return {
        kind: "marketplace",
        marketplace: typeof obj["marketplace"] === "string" ? obj["marketplace"] : "",
        pluginName,
      };
    }
    if (kind === "local") {
      return {
        kind: "local",
        path: typeof obj["path"] === "string" ? obj["path"] : "",
      };
    }
    if (kind === "builtin") {
      return { kind: "builtin" };
    }
    // Default to github
    const repo = typeof obj["repo"] === "string" ? obj["repo"] : pluginName;
    const ref = typeof obj["ref"] === "string" ? obj["ref"] : undefined;
    const subPath = typeof obj["subPath"] === "string" ? obj["subPath"] : undefined;
    return {
      kind: "github",
      repo,
      ...(ref ? { ref } : {}),
      ...(subPath ? { subPath } : {}),
    };
  }
  return { kind: "github", repo: pluginName };
}
