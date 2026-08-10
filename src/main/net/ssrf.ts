/**
 * Shared SSRF (Server-Side Request Forgery) protection.
 *
 * Extracted from tools/web.ts so that the MCP transport layer and plugin
 * manager can use the same guard — the web_fetch check is only effective if
 * EVERY outbound fetch path applies it.
 *
 * Re-exported from tools/web.ts so its existing tests keep passing unchanged.
 */

import { isIP } from "node:net";

/* ----------------------------------------------------------------- helpers */

/**
 * Expand a compressed IPv6 address string to 8 groups of 16-bit hex values.
 * Returns null if the input is not a valid IPv6 address.
 */
function expandIPv6(addr: string): number[] | null {
  // Strip brackets if present
  const bare = addr.replace(/^\[/, "").replace(/\]$/, "");
  if (isIP(bare) !== 6) return null;

  // Split on "::"
  const halves = bare.split("::");
  if (halves.length > 2) return null;

  const left = halves[0] ? halves[0]!.split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1]!.split(":") : [];
  const missing = 8 - left.length - right.length;

  const groups: number[] = [
    ...left.map((g) => parseInt(g, 16)),
    ...Array(missing).fill(0),
    ...right.map((g) => parseInt(g, 16)),
  ];

  if (groups.length !== 8 || groups.some((g) => isNaN(g) || g < 0 || g > 0xffff)) {
    return null;
  }
  return groups;
}

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
  // IPv6 loopback ::1 — check after expansion
  const groups = expandIPv6(bare);
  if (groups) {
    // ::1 is 0:0:0:0:0:0:0:1
    if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 &&
        groups[4] === 0 && groups[5] === 0 && groups[6] === 0 && groups[7] === 1) {
      return true;
    }
    // ::ffff:127.x.x.x  (IPv4-mapped loopback)
    if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 &&
        groups[4] === 0 && groups[5] === 0xffff) {
      const ipv4A = (groups[6]! >> 8) & 0xff;
      if (ipv4A === 127) return true;
    }
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

  // IPv6 loopback — accept both with and without brackets
  if (h === "::1" || h === "[::1]") return true;

  // IPv6 ULA (fc00::/7)
  if (/^\[?f[cd][0-9a-f]{2}:/i.test(h)) return true;

  // Strip brackets for IPv6 addresses
  const bare = h.replace(/^\[/, "").replace(/\]$/, "");

  // IPv4 parsing (decimal dotted form)
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

  // Keep the dotted-form IPv4-mapped check for un-normalised input
  const v4mapped = bare.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (v4mapped) return isPrivateHost(v4mapped[1]!);

  // Normalised IPv6 — expand and classify
  const groups = expandIPv6(bare);
  if (groups) {
    // ::  — unspecified address (all-zeros)
    if (groups.every((g) => g === 0)) return true;

    // ::1 — loopback
    if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 &&
        groups[4] === 0 && groups[5] === 0 && groups[6] === 0 && groups[7] === 1) {
      return true;
    }

    // fe80::/10 — link-local
    const firstByte = (groups[0]! >> 8) & 0xff;
    const secondByte = groups[0]! & 0xff;
    if (firstByte === 0xfe && (secondByte & 0xc0) === 0x80) return true;

    // fc00::/7 — ULA (already caught by regex above, but belt-and-braces)
    if (firstByte >= 0xfc && firstByte <= 0xfd) return true;

    // ::ffff:0:0/96 — IPv4-mapped
    if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 &&
        groups[4] === 0 && groups[5] === 0xffff) {
      // Last 4 bytes encode the IPv4 address
      const ipv4A = (groups[6]! >> 8) & 0xff;
      const ipv4B = groups[6]! & 0xff;
      const ipv4C = (groups[7]! >> 8) & 0xff;
      const ipv4D = groups[7]! & 0xff;
      const syntheticIp = `${ipv4A}.${ipv4B}.${ipv4C}.${ipv4D}`;
      return isPrivateHost(syntheticIp);
    }

    // 64:ff9b::/96 — NAT64 (translates to IPv4 space)
    if (groups[0] === 0x0064 && groups[1] === 0xff9b &&
        groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0) {
      const ipv4A = (groups[6]! >> 8) & 0xff;
      const ipv4B = groups[6]! & 0xff;
      const ipv4C = (groups[7]! >> 8) & 0xff;
      const ipv4D = groups[7]! & 0xff;
      const syntheticIp = `${ipv4A}.${ipv4B}.${ipv4C}.${ipv4D}`;
      return isPrivateHost(syntheticIp);
    }
  }

  return false;
}

/**
 * Throws if `url` would reach a private/internal host.
 *
 * @param url        The URL to check (must be http or https).
 * @param opts       `{ allowLocal }` — when true, localhost/127.x are permitted.
 */
export function assertPublicUrl(url: string, opts: { allowLocal?: boolean } = {}): void {
  const allowLocal = opts.allowLocal ?? false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`SSRF guard: invalid URL "${url}"`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `SSRF guard: only http and https are permitted, got ${parsed.protocol} for "${url}"`,
    );
  }

  const isPrivate = isPrivateHost(parsed.hostname);
  if (!isPrivate) return;

  if (allowLocal && isLocalhostHost(parsed.hostname)) return;

  throw new Error(
    `SSRF guard: requests to private/loopback/link-local addresses are blocked ` +
    `(${parsed.hostname}). Pass allowLocal:true to allow localhost for local dev servers.`,
  );
}
