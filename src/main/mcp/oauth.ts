/**
 * MCP OAuth helper — Authorization Code + PKCE with loopback callback.
 *
 * Implements the OAuth flow required by MCP servers that protect their
 * endpoint with `WWW-Authenticate: Bearer` containing `authorization_uri`
 * and `resource_metadata`. The flow is:
 *  1. Discover resource metadata (/.well-known/oauth-protected-resource)
 *  2. Discover authorization server metadata (/.well-known/oauth-authorization-server)
 *  3. Generate PKCE verifier/challenge
 *  4. Start temporary loopback HTTP server for redirect_uri
 *  5. Open authorization_url in system browser (shell.openExternal)
 *  6. Wait for /callback?code=...
 *  7. Exchange code for access_token at token_endpoint
 *
 * Failures surface as errors so IPC can return {ok:false} and the UI can
 * fallback to manual `authToken` paste.
 */

import { createServer, type Server } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { URL } from "node:url";

export interface OAuthResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  tokenType?: string;
}

function parseWwwAuthenticate(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Header is like: Bearer realm="mcp", authorization_uri="https://...", resource_metadata="https://..."
  const regex = /(\w+)="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(header))) {
    out[m[1]!] = m[2]!;
  }
  // Also handle unquoted scope etc.
  return out;
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = base64UrlEncode(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

async function fetchJson(url: string, opts: RequestInit = {}): Promise<unknown> {
  const res = await fetch(url, {
    ...opts,
    headers: { Accept: "application/json", ...(opts.headers ?? {}) },
    signal: opts.signal ?? AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Fetch ${url} failed: ${res.status} ${res.statusText}`);
  return res.json();
}

export async function discoverOAuthForMcp(mcpUrl: string): Promise<{
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  registrationEndpoint?: string;
  resourceMetadataUrl?: string;
  resource?: string;
  scopes?: string[];
}> {
  const mcpParsed = new URL(mcpUrl);
  const origin = `${mcpParsed.protocol}//${mcpParsed.host}`;

  // Step 1: Try to get 401 challenge from MCP endpoint itself to learn authorization_uri
  let challenge: Record<string, string> = {};
  try {
    const probe = await fetch(mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "probe", method: "ping" }),
      signal: AbortSignal.timeout(8000),
    });
    const www = probe.headers.get("www-authenticate") ?? probe.headers.get("WWW-Authenticate") ?? "";
    if (www) challenge = parseWwwAuthenticate(www);
    // Some servers return JSON error with authorization_uri
    if (!challenge.authorization_uri) {
      try {
        const text = await probe.clone().text();
        const j = JSON.parse(text);
        const uri = j?.error?.data?.authorization_uri ?? j?.authorization_uri;
        if (uri) challenge.authorization_uri = uri;
      } catch { /* ignore */ }
    }
  } catch { /* ignore probe failure */ }

  // If challenge already has authorization_uri, try to derive token endpoint via well-known
  let authServerOrigin = origin;
  if (challenge.authorization_uri) {
    try {
      authServerOrigin = new URL(challenge.authorization_uri).origin;
    } catch { /* keep origin */ }
  }

  // Step 2: Fetch protected-resource metadata (RFC 9728) — gives the RFC 8707
  // `resource` identifier and the authorization_servers list.
  let resourceMeta: unknown = null;
  let resourceIdentifier: string | undefined;
  const rmCandidates = challenge.resource_metadata
    ? [challenge.resource_metadata as string]
    : [
        `${origin}/.well-known/oauth-protected-resource${mcpParsed.pathname}`,
        `${origin}/.well-known/oauth-protected-resource/mcp`,
        `${origin}/.well-known/oauth-protected-resource`,
      ];
  for (const cand of rmCandidates) {
    try {
      resourceMeta = await fetchJson(cand);
      break;
    } catch { /* try next */ }
  }
  if (resourceMeta && typeof resourceMeta === "object") {
    const rm = resourceMeta as Record<string, unknown>;
    if (typeof rm.resource === "string") resourceIdentifier = rm.resource;
  }

  let authorizationEndpoint: string | undefined;
  let tokenEndpoint: string | undefined;
  let registrationEndpoint: string | undefined;
  let scopes: string[] | undefined;

  // Step 3: authorization server metadata (RFC 8414 / OIDC discovery).
  const asOrigins = new Set<string>([authServerOrigin, origin]);
  for (const asOrigin of asOrigins) {
    const asCandidates = [
      `${asOrigin}/.well-known/oauth-authorization-server`,
      `${asOrigin}/.well-known/openid-configuration`,
    ];
    for (const cand of asCandidates) {
      try {
        const meta = (await fetchJson(cand)) as Record<string, unknown>;
        if (typeof meta.authorization_endpoint === "string") authorizationEndpoint = meta.authorization_endpoint;
        if (typeof meta.token_endpoint === "string") tokenEndpoint = meta.token_endpoint;
        if (typeof meta.registration_endpoint === "string") registrationEndpoint = meta.registration_endpoint;
        if (!scopes && Array.isArray(meta.scopes_supported)) scopes = meta.scopes_supported as string[];
        if (authorizationEndpoint && tokenEndpoint) break;
      } catch { /* try next */ }
    }
    if (authorizationEndpoint && tokenEndpoint) break;
  }

  // Direct challenge fallback: authorization_uri without metadata.
  if (!authorizationEndpoint && challenge.authorization_uri) authorizationEndpoint = challenge.authorization_uri;
  if (authorizationEndpoint && !tokenEndpoint) {
    try {
      const derived = authorizationEndpoint.replace(/\/authorize.*$/, "/token").replace(/\/auth.*$/, "/token");
      tokenEndpoint = derived === authorizationEndpoint ? new URL(authorizationEndpoint).origin + "/token" : derived;
    } catch { /* ignore */ }
  }

  return {
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint,
    resourceMetadataUrl: rmCandidates[0],
    resource: resourceIdentifier ?? mcpUrl,
    scopes,
  };
}

/**
 * RFC 7591 Dynamic Client Registration. Returns the issued client_id (and
 * secret when the AS requires a confidential client). Throws with an
 * actionable message when DCR is unavailable so callers can fall back to the
 * manual-token path instead of failing later with `invalid_client`.
 */
export async function registerDynamicClient(opts: {
  registrationEndpoint: string;
  redirectUri: string;
  scopes: string[];
}): Promise<{ clientId: string; clientSecret?: string }> {
  const body: Record<string, unknown> = {
    client_name: "Kozum Cowork",
    redirect_uris: [opts.redirectUri],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    application_type: "web",
  };
  if (opts.scopes.length) body.scope = opts.scopes.join(" ");

  const res = await fetch(opts.registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Dynamic client registration failed (${res.status}): ${text.slice(0, 300)}. ` +
        `If this server does not support OAuth registration, add it with a manual auth token instead.`,
    );
  }
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`DCR endpoint returned non-JSON: ${text.slice(0, 300)}`);
  }
  const clientId = j.client_id as string | undefined;
  if (!clientId) throw new Error(`DCR response had no client_id: ${text.slice(0, 300)}`);
  return {
    clientId,
    clientSecret: typeof j.client_secret === "string" ? j.client_secret : undefined,
  };
}

export function createLoopbackServer(): Promise<{
  server: Server;
  port: number;
  url: string;
  waitForCode: Promise<{ code: string; state: string }>;
  close: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    let codeResolve: (v: { code: string; state: string }) => void;
    let codeReject: (e: Error) => void;
    const waitForCode = new Promise<{ code: string; state: string }>((res, rej) => {
      codeResolve = res;
      codeReject = rej;
    });

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state") ?? "";
        const error = url.searchParams.get("error");
        if (error) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<html><body><h2>Login failed: ${error}</h2><p>${url.searchParams.get("error_description") ?? ""}</p><p>You can close this window.</p></body></html>`);
          codeReject(new Error(`OAuth error: ${error} ${url.searchParams.get("error_description") ?? ""}`));
          return;
        }
        if (code) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>✓ Login successful</h2><p>You can close this window and return to Kozum.</p><script>window.close(); setTimeout(()=>close, 2000)</script></body></html>`);
          codeResolve({ code, state });
        } else {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<html><body><h2>Missing code</h2><p>No code parameter in callback.</p></body></html>`);
          codeReject(new Error("Missing code in callback"));
        }
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to bind loopback server"));
        return;
      }
      const port = addr.port;
      const url = `http://127.0.0.1:${port}/callback`;
      resolve({
        server,
        port,
        url,
        waitForCode,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });

    server.on("error", reject);
    // Timeout after 5 minutes
    setTimeout(() => {
      codeReject(new Error("OAuth login timed out after 5 minutes. Please try again."));
      server.close(() => {});
    }, 5 * 60 * 1000).unref?.();
  });
}

export async function exchangeCodeForToken(opts: {
  tokenEndpoint: string;
  code: string;
  verifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret?: string;
  resource?: string;
}): Promise<OAuthResult> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    code_verifier: opts.verifier,
  });
  if (opts.resource) body.set("resource", opts.resource);

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  // Confidential clients authenticate with HTTP Basic per RFC 6749 §2.3.1.
  if (opts.clientSecret) {
    const basic = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString("base64");
    headers.Authorization = `Basic ${basic}`;
  }

  const res = await fetch(opts.tokenEndpoint, {
    method: "POST",
    headers,
    body: body.toString(),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) {
    let hint = "";
    if (res.status === 400 || res.status === 401) {
      try {
        const j = JSON.parse(text) as Record<string, unknown>;
        if (j.error === "invalid_client") {
          hint = " The registered client was rejected — remove and re-add this server to re-run registration.";
        }
      } catch { /* raw text shown below */ }
    }
    throw new Error(`Token exchange failed: ${res.status} ${text.slice(0, 500)}${hint}`);
  }
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`Token endpoint returned non-JSON: ${text.slice(0, 500)}`);
  }
  const accessToken = (j.access_token as string) ?? (j.accessToken as string);
  if (!accessToken) throw new Error(`No access_token in token response: ${text.slice(0, 500)}`);
  return {
    accessToken,
    refreshToken: (j.refresh_token as string) ?? undefined,
    expiresIn: typeof j.expires_in === "number" ? j.expires_in : undefined,
    tokenType: (j.token_type as string) ?? "Bearer",
  };
}

export async function startMcpOAuthFlow(opts: {
  mcpUrl: string;
  openExternal: (url: string) => Promise<void> | void;
  /** Previously registered client_id (RFC7591) persisted for this server. */
  existingClientId?: string;
  scopes?: string[];
}): Promise<OAuthResult & { clientId: string }> {
  const discovered = await discoverOAuthForMcp(opts.mcpUrl);
  const scopes = opts.scopes ?? discovered.scopes ?? [];

  if (!discovered.authorizationEndpoint || !discovered.tokenEndpoint) {
    throw new Error(
      `Could not discover OAuth endpoints for ${opts.mcpUrl}. ` +
        `If this server uses a static token, add it with the "Auth token" field instead.`,
    );
  }

  const { verifier, challenge } = generatePkce();
  const state = base64UrlEncode(randomBytes(16));
  // Bind the loopback listener FIRST so DCR can register this exact redirect_uri.
  const loopback = await createLoopbackServer();

  // Resolve or create the OAuth client (RFC 7591). A made-up client_id is what
  // produces `invalid_client`, so registration is mandatory when we have none.
  let clientId = opts.existingClientId;
  let clientSecret: string | undefined;
  try {
    if (!clientId && discovered.registrationEndpoint) {
      const registered = await registerDynamicClient({
        registrationEndpoint: discovered.registrationEndpoint,
        redirectUri: loopback.url,
        scopes,
      });
      clientId = registered.clientId;
      clientSecret = registered.clientSecret;
    }
  } catch (cause) {
    await loopback.close().catch(() => {});
    throw cause;
  }
  if (!clientId) {
    await loopback.close().catch(() => {});
    throw new Error(
      `The authorization server for ${opts.mcpUrl} does not advertise a registration_endpoint, ` +
        `and no client was registered previously. Add this server with a manual auth token instead.`,
    );
  }

  try {
    // Build authorization URL
    const authUrl = new URL(discovered.authorizationEndpoint!);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", loopback.url);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", state);
    if (scopes.length) authUrl.searchParams.set("scope", scopes.join(" "));
    // RFC 8707 resource indicator — required by many MCP gateways.
    authUrl.searchParams.set("resource", discovered.resource ?? opts.mcpUrl);

    await opts.openExternal(authUrl.toString());

    let code: string;
    try {
      const result = await loopback.waitForCode;
      if (result.state && result.state !== state) {
        console.warn("[mcp oauth] state mismatch", result.state, state);
      }
      code = result.code;
    } finally {
      await loopback.close().catch(() => {});
    }

    const token = await exchangeCodeForToken({
      tokenEndpoint: discovered.tokenEndpoint!,
      code,
      verifier,
      redirectUri: loopback.url,
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
      resource: discovered.resource ?? opts.mcpUrl,
    });
    return { ...token, clientId };
  } finally {
    await loopback.close().catch(() => {});
  }
}
