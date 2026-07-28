/**
 * Web tools — fetch and search the public internet.
 *
 * SSRF protection: private/loopback/link-local IP ranges are blocked on every
 * fetch and on every redirect hop. A public URL redirecting to 169.254.169.254
 * (cloud metadata service) is the classic attack vector — this is why the check
 * runs on redirects too.
 */

import { htmlToText } from "../net/html.ts";
import type { Tool } from "./registry.ts";
import { ok, fail, describeError } from "./registry.ts";

/* ----------------------------------------------------------- SSRF guard --- */

/**
 * Returns true when the hostname is specifically localhost or 127.x.x.x.
 *
 * Used to determine whether `allowLocal: true` should exempt the address.
 * 169.254.x, 10.x, 172.16.x, 192.168.x are NOT covered here — those are
 * private but not "localhost" and should never be exempted.
 */
export function isLocalhostHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "ip6-localhost" || h === "ip6-loopback") return true;
  if (h === "::1" || h === "[::1]") return true;
  const bare = h.replace(/^\[/, "").replace(/\]$/, "");
  const v4 = bare.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    if (a === 127) return true;
  }
  return false;
}

/**
 * Returns true when the hostname resolves to a private/loopback/link-local
 * address that should be blocked.
 *
 * This is a syntactic check — it catches literal IP addresses and
 * `localhost`. A DNS-rebind attack (domain -> private IP) is partially covered
 * because `fetch` in Node uses `getaddrinfo` which returns the IP; however,
 * intercepting that requires a custom agent. For the common cases (literal
 * 127.0.0.1, 10.x, 169.254.x, ::1) this is fully effective.
 */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();

  // Loopback names
  if (h === "localhost") return true;
  if (h.endsWith(".localhost")) return true;
  if (h === "ip6-localhost" || h === "ip6-loopback") return true;

  // IPv6 loopback
  if (h === "::1" || h === "[::1]") return true;

  // IPv6 ULA (fc00::/7)
  if (/^\[?f[cd][0-9a-f]{2}:/i.test(h)) return true;

  // Strip brackets for IPv6 addresses
  const bare = h.replace(/^\[/, "").replace(/\]$/, "");

  // IPv4 parsing
  const v4 = bare.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [, a, b, c] = v4.map(Number) as [number, number, number, number, number];
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local / metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a === 203 && b === 0 && c === 113) return true; // documentation
    if (a === 240) return true; // reserved
    if (a === 255 && b === 255 && c === 255) return true; // broadcast
  }

  // IPv4-mapped IPv6 ::ffff:10.x.x.x etc.
  const v4mapped = bare.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (v4mapped) return isPrivateHost(v4mapped[1]!);

  return false;
}

function checkSsrf(url: string, allowLocal: boolean): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `Invalid URL: ${url}`;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `Only http and https URLs are supported, got ${parsed.protocol}`;
  }

  const isPrivate = isPrivateHost(parsed.hostname);
  if (!isPrivate) return null;

  // allowLocal only exempts localhost / 127.x.x.x — never 169.254.x, 10.x, etc.
  if (allowLocal && isLocalhostHost(parsed.hostname)) return null;

  return (
    `Requests to private/loopback addresses are blocked to prevent SSRF ` +
    `(${parsed.hostname}). Pass allowLocal: true to allow localhost requests ` +
    `for local development servers.`
  );
}

/* -------------------------------------------------------------- fetch ---- */

const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB

async function fetchUrl(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
    allowLocal?: boolean;
  },
): Promise<{ content: string; contentType: string; truncated: boolean; finalUrl: string }> {
  const allowLocal = options.allowLocal ?? false;

  // Pre-check the initial URL
  const initialErr = checkSsrf(url, allowLocal);
  if (initialErr) throw new Error(initialErr);

  const controller = new AbortController();
  const timeoutHandle = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 30_000,
  );

  let redirectCount = 0;
  let currentUrl = url;

  try {
    while (true) {
      const resp = await fetch(currentUrl, {
        method: options.method ?? "GET",
        headers: options.headers,
        body: options.body,
        signal: controller.signal,
        redirect: "manual", // handle redirects manually for SSRF check
      });

      // Handle redirects
      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.get("location");
        if (!location) throw new Error(`Redirect (${resp.status}) with no Location header`);

        redirectCount++;
        if (redirectCount > MAX_REDIRECTS) {
          throw new Error(`Too many redirects (limit ${MAX_REDIRECTS})`);
        }

        // Resolve relative redirects
        const next = new URL(location, currentUrl).toString();

        // SSRF check on redirect destination — this is the critical check
        const redirectErr = checkSsrf(next, allowLocal);
        if (redirectErr) {
          throw new Error(`Redirect blocked (SSRF protection): ${redirectErr}`);
        }

        // Consume the body to free the connection
        await resp.text().catch(() => undefined);
        currentUrl = next;
        continue;
      }

      const contentType = resp.headers.get("content-type") ?? "application/octet-stream";

      // Read body with size cap
      const reader = resp.body?.getReader();
      if (!reader) {
        return { content: `(empty body — status ${resp.status})`, contentType, truncated: false, finalUrl: currentUrl };
      }

      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      let truncated = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > MAX_BODY_BYTES) {
            // Keep what we have, mark as truncated, cancel the stream
            truncated = true;
            chunks.push(value.slice(0, value.byteLength - (totalBytes - MAX_BODY_BYTES)));
            await reader.cancel().catch(() => undefined);
            break;
          }
          chunks.push(value);
        }
      }

      // Combine chunks
      const combined = new Uint8Array(chunks.reduce((s, c) => s + c.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
      }

      const rawText = new TextDecoder("utf-8", { fatal: false }).decode(combined);

      let content: string;
      const ct = contentType.toLowerCase();

      if (ct.includes("text/html") || ct.includes("application/xhtml")) {
        content = htmlToText(rawText, { markdown: true });
        if (truncated) content += "\n\n[Response was truncated at 2 MB]";
      } else if (ct.includes("application/json") || ct.includes("text/json")) {
        try {
          const parsed = JSON.parse(rawText);
          content = JSON.stringify(parsed, null, 2);
        } catch {
          content = rawText;
        }
        if (truncated) content += "\n\n[Response was truncated at 2 MB]";
      } else if (ct.startsWith("text/")) {
        content = rawText;
        if (truncated) content += "\n\n[Response was truncated at 2 MB]";
      } else {
        // Binary or unknown
        const sizeStr = totalBytes >= 1024 * 1024
          ? `${(totalBytes / 1024 / 1024).toFixed(1)} MB`
          : `${(totalBytes / 1024).toFixed(1)} KB`;
        content = `[Binary or non-text response]\nContent-Type: ${contentType}\nSize: ${sizeStr}${truncated ? " (truncated)" : ""}`;
      }

      return { content, contentType, truncated, finalUrl: currentUrl };
    }
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/* -------------------------------------------------------- DDG parsing ---- */

/**
 * Parse DuckDuckGo HTML search results.
 *
 * Exported as a pure function so it can be unit-tested with a local fixture
 * without making real network requests.
 */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Decode DuckDuckGo's `/l/?uddg=...` redirect wrapper to the real URL.
 */
export function decodeDdgUrl(href: string): string {
  try {
    const u = new URL(href, "https://duckduckgo.com");
    if (u.pathname === "/l/") {
      const uddg = u.searchParams.get("uddg");
      if (uddg) return decodeURIComponent(uddg);
    }
    // Also handle //duckduckgo.com/l/?uddg=...
    if (u.hostname === "duckduckgo.com" && u.pathname === "/l/") {
      const uddg = u.searchParams.get("uddg");
      if (uddg) return decodeURIComponent(uddg);
    }
  } catch {
    // fall through
  }
  return href;
}

/**
 * Parse DuckDuckGo HTML markup into structured results.
 *
 * DDG's HTML endpoint (/html/?q=...) returns results in a predictable
 * structure. This parser extracts title, URL, and snippet from each result
 * block.
 */
export function parseDdgHtml(html: string): SearchResult[] {
  const results: SearchResult[] = [];

  // Each result is in a div with class "result" or "web-result"
  // The title link has class "result__a"
  // The snippet has class "result__snippet"
  // The URL display has class "result__url"

  // Split by result blocks
  const resultBlocks = html.split(/<div[^>]+class="[^"]*result[^"]*"[^>]*>/i);

  for (const block of resultBlocks.slice(1)) {
    // Extract title and href from result__a link
    const titleMatch = block.match(
      /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i,
    );
    if (!titleMatch) continue;

    const rawHref = titleMatch[1] ?? "";
    const titleHtml = titleMatch[2] ?? "";
    const url = decodeDdgUrl(rawHref);
    const title = htmlToText(titleHtml, { markdown: false }).trim();

    if (!url || !title) continue;

    // Skip DDG internal links
    if (url.startsWith("https://duckduckgo.com") || url.startsWith("//duckduckgo.com")) continue;

    // Extract snippet
    const snippetMatch = block.match(
      /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i,
    );
    const snippetHtml = snippetMatch?.[1] ?? "";
    const snippet = htmlToText(snippetHtml, { markdown: false }).trim();

    results.push({ title, url, snippet });
  }

  return results;
}

/* -------------------------------------------------------------- tools ---- */

export const webTools: Tool[] = [
  /* ---------------------------------------------------------------- web_fetch */
  {
    definition: {
      name: "web_fetch",
      title: "Fetch URL",
      description:
        "Fetch the content of a URL and return it as readable text. " +
        "HTML pages are converted to readable text/Markdown (scripts, styles, and nav stripped). " +
        "JSON responses are pretty-printed. Binary files report their content-type and size. " +
        "Requests to private IP ranges (127.x, 10.x, 172.16-31.x, 192.168.x, 169.254.x) are " +
        "blocked by default to prevent SSRF attacks. Set allowLocal:true to reach localhost " +
        "development servers. Follows redirects (max 5), re-checking SSRF on each hop. " +
        "Response bodies are capped at 2 MB.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The URL to fetch. Must be http or https.",
          },
          method: {
            type: "string",
            description: "HTTP method. Defaults to GET.",
            default: "GET",
          },
          headers: {
            type: "object",
            description: "HTTP request headers as a key/value object.",
          },
          body: {
            type: "string",
            description: "Request body string (for POST/PUT).",
          },
          timeout: {
            type: "number",
            description: "Request timeout in milliseconds. Defaults to 30000.",
            default: 30000,
          },
          allowLocal: {
            type: "boolean",
            description:
              "Set true to allow requests to localhost/127.0.0.1 for local dev servers. " +
              "SSRF checks are still applied to non-localhost private ranges.",
            default: false,
          },
        },
        required: ["url"],
      },
      icon: "globe",
      group: "web",
      modes: ["cowork", "code"],
    },

    handler: async (input, _ctx) => {
      const url = String(input["url"] ?? "").trim();
      const method = String(input["method"] ?? "GET").toUpperCase();
      const headers =
        input["headers"] && typeof input["headers"] === "object" && !Array.isArray(input["headers"])
          ? (input["headers"] as Record<string, string>)
          : undefined;
      const body = input["body"] !== undefined ? String(input["body"]) : undefined;
      const timeoutMs = typeof input["timeout"] === "number" ? input["timeout"] : 30_000;
      const allowLocal = input["allowLocal"] === true;

      if (!url) return fail("url is required");

      // Validate scheme before anything else
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return fail(`Only http and https URLs are supported, got: ${parsed.protocol}`);
        }
      } catch {
        return fail(`Invalid URL: ${url}`);
      }

      try {
        const { content, contentType, truncated, finalUrl } = await fetchUrl(url, {
          method,
          headers,
          body,
          timeoutMs,
          allowLocal,
        });

        const summary =
          (finalUrl !== url ? `Fetched ${finalUrl} (redirected)` : `Fetched ${url}`) +
          (truncated ? " — truncated at 2 MB" : "");

        return ok(
          content,
          {
            summary,
            detail: `Content-Type: ${contentType}${truncated ? " | Truncated at 2 MB" : ""}`,
          },
        );
      } catch (e) {
        return fail(describeError(e));
      }
    },
  },

  /* --------------------------------------------------------------- web_search */
  {
    definition: {
      name: "web_search",
      title: "Web Search",
      description:
        "Search the web using DuckDuckGo and return titles, URLs, and snippets. " +
        "By default returns up to 8 results. Set includeContent:true to also fetch " +
        "and include a brief excerpt from the top results.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query.",
          },
          limit: {
            type: "number",
            description: "Maximum number of results to return. Defaults to 8.",
            default: 8,
          },
          includeContent: {
            type: "boolean",
            description: "When true, fetch the top few results and include a content snippet.",
            default: false,
          },
        },
        required: ["query"],
      },
      icon: "search",
      group: "web",
      modes: ["cowork", "code"],
    },

    handler: async (input, _ctx) => {
      const query = String(input["query"] ?? "").trim();
      if (!query) return fail("query is required");

      const limit = typeof input["limit"] === "number" ? Math.min(Math.max(1, input["limit"]), 20) : 8;
      const includeContent = input["includeContent"] === true;

      // DuckDuckGo HTML endpoint
      const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

      let ddgHtml: string;
      try {
        const resp = await fetch(searchUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
              "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
            Accept: "text/html,application/xhtml+xml",
            "Accept-Language": "en-US,en;q=0.9",
          },
          redirect: "follow",
        });
        ddgHtml = await resp.text();
      } catch (e) {
        return fail(
          `Could not reach DuckDuckGo search: ${describeError(e)}. ` +
            `Check network connectivity.`,
        );
      }

      const results = parseDdgHtml(ddgHtml).slice(0, limit);

      if (results.length === 0) {
        return fail(
          `DuckDuckGo returned no parseable results for "${query}". ` +
            `The search backend markup may have changed, or the query returned ` +
            `no results. Try a different query or check the network.`,
        );
      }

      // Format results
      const lines: string[] = [`Search results for: ${query}\n`];

      for (let i = 0; i < results.length; i++) {
        const r = results[i]!;
        lines.push(`${i + 1}. **${r.title}**`);
        lines.push(`   ${r.url}`);
        if (r.snippet) lines.push(`   ${r.snippet}`);
        lines.push("");
      }

      if (includeContent && results.length > 0) {
        const topN = Math.min(3, results.length);
        lines.push(`\n--- Content snippets from top ${topN} results ---\n`);

        for (let i = 0; i < topN; i++) {
          const r = results[i]!;
          lines.push(`\n### ${r.title}\n${r.url}\n`);

          const ssrfErr = checkSsrf(r.url, false);
          if (ssrfErr) {
            lines.push(`(Skipped — ${ssrfErr})\n`);
            continue;
          }

          try {
            const { content } = await fetchUrl(r.url, { timeoutMs: 15_000 });
            // Include first 1500 chars as a snippet
            const snippet = content.slice(0, 1500).trim();
            lines.push(snippet + (content.length > 1500 ? "\n[... more content available via web_fetch]" : ""));
          } catch (e) {
            lines.push(`(Could not fetch: ${describeError(e)})\n`);
          }
          lines.push("");
        }
      }

      return ok(
        lines.join("\n"),
        { summary: `Found ${results.length} results for "${query}"` },
      );
    },
  },
];
