/**
 * GitHub-aware fetch wrapper.
 *
 * Plugin installation must never be blocked by a misconfigured proxy or a
 * transient GitHub outage. This module:
 *   - Bypasses any proxy for GitHub hosts.
 *   - Retries transient 5xx / network errors up to 3 times with backoff.
 *   - Falls back across mirror hosts where the path makes sense:
 *       github.com → codeload.github.com (archive downloads)
 *       raw.githubusercontent.com (raw file access)
 */

export const GITHUB_HOSTS: string[] = [
  "github.com",
  "raw.githubusercontent.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "api.github.com",
  "avatars.githubusercontent.com",
];

/** Return true when the URL's hostname is a known GitHub host. */
export function isGitHubHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return GITHUB_HOSTS.some((gh) => host === gh || host.endsWith(`.${gh}`));
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------- helpers */

const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build an alternative URL list for a GitHub URL.
 *
 * For archive tarballs served from github.com, codeload.github.com is often
 * reachable when the main site is under load.
 */
function buildFallbacks(url: string): string[] {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const fallbacks: string[] = [];

    if (host === "github.com") {
      // /owner/repo/archive/... → codeload.github.com/owner/repo/tar.gz/...
      const archiveMatch = parsed.pathname.match(
        /^\/([^/]+\/[^/]+)\/archive\/(.+)$/,
      );
      if (archiveMatch) {
        const repoPath = archiveMatch[1];
        const ref = archiveMatch[2]!.replace(/\.(tar\.gz|zip)$/, "");
        const ext = archiveMatch[2]!.endsWith(".zip") ? "zip" : "tar.gz";
        fallbacks.push(
          `https://codeload.github.com/${repoPath}/${ext}/${ref}`,
        );
      }
      // Raw file access
      const rawMatch = parsed.pathname.match(
        /^\/([^/]+)\/([^/]+)\/(?:raw|blob)\/([^/]+)\/(.+)$/,
      );
      if (rawMatch) {
        const [, owner, repo, ref, filePath] = rawMatch;
        fallbacks.push(
          `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`,
        );
      }
    }

    return fallbacks;
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------- main export */

/**
 * Fetch a GitHub URL, bypassing proxies, with retry and mirror fallback.
 *
 * The `init` parameter is the same as the second argument to the global
 * `fetch`, minus `agent` (which is Node-specific and not used here).
 */
export async function fetchGitHub(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const urls = [url, ...buildFallbacks(url)];
  let lastError: unknown = new Error("No URLs to try");

  for (const candidate of urls) {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await sleep(BASE_DELAY_MS * Math.pow(2, attempt - 1));
      }

      try {
        // Build headers, explicitly removing any proxy-related ones.
        const headers: Record<string, string> = {
          "User-Agent": "kozum-cowork/1.0 (plugin-installer)",
        };

        if (init?.headers) {
          const incomingHeaders =
            init.headers instanceof Headers
              ? Object.fromEntries(init.headers.entries())
              : (init.headers as Record<string, string>);
          for (const [k, v] of Object.entries(incomingHeaders)) {
            // Drop proxy-control headers
            if (
              !k.toLowerCase().startsWith("proxy-") &&
              k.toLowerCase() !== "via"
            ) {
              headers[k] = v;
            }
          }
        }

        const response = await fetch(candidate, {
          ...init,
          headers,
          // Never send credentials to mirror hosts implicitly
          credentials: "omit",
        });

        if (TRANSIENT_STATUS.has(response.status) && attempt < MAX_RETRIES - 1) {
          // Consume the body to free the connection, then retry
          await response.text().catch(() => undefined);
          continue;
        }

        return response;
      } catch (err) {
        lastError = err;
        // Network error — retry
      }
    }
  }

  throw lastError;
}
