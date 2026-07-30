/**
 * Vertex AI Gemini adapter.
 *
 * Same request/response wire format as GeminiAdapter — it reuses
 * parseGeminiStream(), toGeminiContents() and toGeminiTools() from gemini.ts.
 * What differs:
 *
 *  - URL: `{baseUrl}/projects/{projectId}/locations/{region}/publishers/google/models/{model}:streamGenerateContent?alt=sse`
 *  - Auth: `Authorization: Bearer <short-lived-oauth-token>` (not an API key).
 *    `ctx.apiKey` holds either:
 *    (a) A raw access token (e.g. printed by `gcloud auth print-access-token`).
 *    (b) A service-account JSON containing `private_key` + `client_email`.
 *        In case (b) we mint a JWT signed with RS256, exchange it at the Google
 *        token endpoint, and cache the result until ~5 minutes before expiry.
 *
 * Token caching is keyed on the service-account email so multiple adapter
 * instances sharing the same credential do not mint independent tokens.
 *
 * RSA-SHA256 signing uses the built-in `node:crypto` createSign — no new deps.
 */

import crypto from "node:crypto";
import { parseGeminiStream, toGeminiContents, toGeminiTools } from "./gemini.ts";
import type { ModelInfo } from "../../../shared/types.ts";
import {
  errorFromResponse,
  fetchWithRetry,
  ProviderError,
  type CompletionRequest,
  type ProviderAdapter,
  type ProviderContext,
  type StreamDelta,
} from "../adapter.ts";

/* --------------------------------------------------- token cache ---- */

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}

const tokenCache = new Map<string, CachedToken>();

const CLOCK_SKEW_MS = 5 * 60 * 1000; // 5 min grace
const TOKEN_TTL_S = 3600; // tokens are valid for 1 h

/**
 * Return a valid Bearer token for the given credential.
 *
 * If `apiKey` is a JSON object with `private_key` + `client_email`, we go
 * through the JWT→access-token exchange. Otherwise we treat it as a raw token
 * and use it directly.
 */
export async function resolveToken(
  apiKey: string,
  tokenEndpointOverride?: string,
): Promise<string> {
  // Fast path: not JSON → use as-is.
  let sa: { private_key?: string; client_email?: string } | null = null;
  try {
    const parsed = JSON.parse(apiKey);
    if (
      parsed &&
      typeof parsed.private_key === "string" &&
      typeof parsed.client_email === "string"
    ) {
      sa = parsed as { private_key: string; client_email: string };
    }
  } catch {
    /* not JSON */
  }

  if (!sa) return apiKey;

  const email = sa.client_email!;
  const cached = tokenCache.get(email);
  if (cached && cached.expiresAt - CLOCK_SKEW_MS > Date.now()) {
    return cached.token;
  }

  const token = await mintAccessToken(sa.private_key!, email, tokenEndpointOverride);
  tokenCache.set(email, { token, expiresAt: Date.now() + TOKEN_TTL_S * 1000 });
  return token;
}

/**
 * Exchange a service-account private key for a short-lived access token.
 * Signs a JWT with RS256, then POSTs to the Google token endpoint.
 */
async function mintAccessToken(
  privateKey: string,
  clientEmail: string,
  endpointOverride?: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const endpoint = endpointOverride ?? "https://oauth2.googleapis.com/token";

  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64url(
    JSON.stringify({
      iss: clientEmail,
      sub: clientEmail,
      aud: endpoint,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      iat: now,
      exp: now + TOKEN_TTL_S,
    }),
  );

  const sigInput = `${header}.${claim}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(sigInput);
  const sig = base64url(signer.sign(privateKey));
  const jwt = `${sigInput}.${sig}`;

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt,
  });

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Vertex token exchange failed (${res.status}): ${text}`);
  }

  const json = (await res.json()) as any;
  if (!json.access_token) {
    throw new Error("Vertex token response missing access_token");
  }
  return json.access_token as string;
}

function base64url(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64url");
}

/* ------------------------------------------------------------ adapter --- */

export class VertexGeminiAdapter implements ProviderAdapter {
  readonly protocol = "vertex-gemini";

  // Token endpoint override — only set in tests to point at a local server.
  tokenEndpointOverride: string | undefined = undefined;

  private readonly _callCounter = { n: 0 };

  async *stream(
    ctx: ProviderContext,
    req: CompletionRequest,
  ): AsyncIterable<StreamDelta> {
    const projectId = ctx.meta.projectId ?? "";
    const region = ctx.meta.region ?? "";

    if (!projectId) {
      throw new ProviderError({
        message:
          "Vertex AI requires a project ID. Add projectId to your key's metadata in Settings → API Keys.",
        providerId: ctx.providerId,
      });
    }
    if (!region) {
      throw new ProviderError({
        message:
          "Vertex AI requires a region (e.g. us-central1). Add region to your key's metadata in Settings → API Keys.",
        providerId: ctx.providerId,
      });
    }

    const token = await resolveToken(ctx.apiKey, this.tokenEndpointOverride);

    const url =
      `${ctx.baseUrl}/projects/${projectId}/locations/${region}` +
      `/publishers/google/models/${req.model}:streamGenerateContent?alt=sse`;

    const body: Record<string, unknown> = {
      contents: toGeminiContents(req.messages),
      generationConfig: {
        maxOutputTokens: req.maxTokens,
        temperature: req.temperature,
      },
    };
    if (req.system.trim()) {
      body.systemInstruction = { parts: [{ text: req.system }] };
    }
    const tools = toGeminiTools(req.tools);
    if (tools) body.tools = tools;

    const res = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          ...ctx.extraHeaders,
        },
        body: JSON.stringify(body),
        signal: req.signal,
      },
      { providerId: ctx.providerId },
    );

    if (!res.ok) throw await errorFromResponse(res, ctx.providerId);
    if (!res.body) {
      throw new ProviderError({
        message: "provider returned no response body",
        providerId: ctx.providerId,
      });
    }

    yield* parseGeminiStream(res.body, req.signal, this._callCounter);
  }

  async listModels(_ctx: ProviderContext): Promise<ModelInfo[] | null> {
    // Vertex has no simple catalogue endpoint; callers fall back to staticModels.
    return null;
  }
}
