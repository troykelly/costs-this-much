/**
 * @fileoverview Production-ready API Worker that issues and refreshes JWTs,
 * enforces rate limits via a separate DO, and retrieves AEMO data from the
 * shared DO. Endpoints:
 *   - POST /token
 *   - POST /refresh
 *   - GET /data
 *   - GET /.well-known/jwks.json
 */
import { createSigner, createVerifier } from "./jwtSupport";
import { Env, KeyDefinition } from "./types";

/**
 * Parses the base64-encoded spki PEM from your environment's "public" field,
 * which itself includes "-----BEGIN PUBLIC KEY-----" lines. We must decode from
 * base64 → ASCII text (with headers), then strip headers & footers, then decode
 * to binary for the WebCrypto importKey call.
 * 
 * This fixes the "double-encoded" scenario (because your .dev.vars stores a second
 * base64 of the entire ASCII file).
 */
async function parsePublicKeyToJwkFromB64(b64Pem: string): Promise<{ n: string; e: string }> {
  // First, decode from base64 => ASCII text (which should include the PEM headers).
  const asciiPem = atob(b64Pem);

  // Now strip out the "-----BEGIN PUBLIC KEY-----" and "-----END PUBLIC KEY-----" lines,
  // along with any newlines, leaving the raw base64 that SPKI expects.
  let contents = asciiPem.trim();

  const pemHeader = "-----BEGIN PUBLIC KEY-----";
  const pemFooter = "-----END PUBLIC KEY-----";

  if (contents.startsWith(pemHeader)) {
    contents = contents.slice(pemHeader.length);
  }
  if (contents.endsWith(pemFooter)) {
    contents = contents.slice(0, -pemFooter.length);
  }

  // Remove whitespace/newlines
  contents = contents.replace(/[\r\n\s]/g, "");

  // Now decode that base64 → binary
  const rawBinary = Uint8Array.from(atob(contents), (c) => c.charCodeAt(0));

  // Import as spki
  const key = await crypto.subtle.importKey(
    "spki",
    rawBinary.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    true,
    ["verify"]
  );

  // Export to JWK
  const jwk = (await crypto.subtle.exportKey("jwk", key)) as JsonWebKey;
  if (!jwk.n || !jwk.e) {
    throw new Error("Failed to parse RSA public key (missing n or e)");
  }
  return { n: jwk.n, e: jwk.e };
}

export default {
  /**
   * Invoked by Cloudflare’s scheduler as configured in wrangler.*.toml (e.g. every 5min).
   * Triggers the DO's /sync route to fetch and insert intervals.
   */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const logLevel = env.LOG_LEVEL ?? 'WARN';
    if (getLogPriority(logLevel) <= getLogPriority('INFO')) {
      console.log(`[INFO] Scheduled event triggered. Invoking DO sync with LOG_LEVEL="${logLevel}".`);
    }

    const id = env.AEMO_DATA.idFromName('AEMO_LOGGER');
    const stub = env.AEMO_DATA.get(id);
    await stub.fetch('https://dummy-url/sync', { method: 'POST' });
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // If this is a preflight request, respond immediately with CORS headers
    if (request.method === "OPTIONS") {
      return handleOptionsRequest(request, env);
    }

    // First, enforce rate limit
    const rateLimitResult = await checkRateLimit(request, env);
    if (!rateLimitResult.allowed) {
      const resp = new Response("Too Many Requests", { status: 429 });
      return addCorsHeaders(request, env, resp);
    }

    const url = new URL(request.url);

    if (url.pathname === "/.well-known/jwks.json") {
      const r = await this.handleJwks(env);
      return addCorsHeaders(request, env, r);
    } else if (url.pathname === "/token" && request.method === "POST") {
      const r = await this.handleTokenRequest(request, env);
      return addCorsHeaders(request, env, r);
    } else if (url.pathname === "/refresh" && request.method === "POST") {
      const r = await this.handleRefreshRequest(request, env);
      return addCorsHeaders(request, env, r);
    } else if (url.pathname === "/data" && request.method === "GET") {
      const r = await this.handleDataRequest(request, env);
      return addCorsHeaders(request, env, r);
    }

    const resp = new Response("Not found", { status: 404 });
    return addCorsHeaders(request, env, resp);
  },

  /**
   * Return public JWKS info from SIGNING_KEYS. Now we decode each "public" field
   * properly if it's been base64-encoded with the full "BEGIN PUBLIC KEY" text.
   */
  async handleJwks(env: Env): Promise<Response> {
    try {
      const keys: KeyDefinition[] = JSON.parse(env.SIGNING_KEYS || "[]");
      const now = Date.now();
      const activePromises = [];

      for (const k of keys) {
        if (k.revoked) {
          continue;
        }
        // Interpret k.start/k.expire as Unix seconds
        const startTime = (k.start ?? 0) * 1000;
        const endTime = (k.expire ?? 0) * 1000;
        if (startTime <= now && now < endTime) {
          // We'll parse the "public" field as base64 => ASCII => spki => JWK
          activePromises.push(
            parsePublicKeyToJwkFromB64(k.public).then(({ n, e }) => ({
              kty: "RSA",
              alg: "RS256",
              use: "sig",
              kid: k.id,
              n,
              e,
            }))
          );
        }
      }

      const jwks = await Promise.all(activePromises);
      return new Response(JSON.stringify({ keys: jwks }, null, 2), {
        headers: { "content-type": "application/json" },
      });
    } catch (err) {
      return new Response("Error constructing JWKS: " + (err as Error).message, { status: 500 });
    }
  },

  /**
   * Issue a short-lived token and refresh token (best practice: ~15m access token, ~14d refresh).
   */
  async handleTokenRequest(request: Request, env: Env): Promise<Response> {
    try {
      const body = await request.json<any>();
      const clientId = body?.client_id;
      if (!isValidClientId(clientId, env)) {
        return new Response("Invalid client_id", { status: 401 });
      }

      // Find the current signing key
      const { signingKey, kid } = findCurrentSigningKey(env);
      if (!signingKey) {
        return new Response("No active signing key", { status: 500 });
      }

      const shortLived = await createSigner(signingKey, kid, clientId, 15 * 60);
      const refresh = await createSigner(signingKey, kid, clientId, 14 * 24 * 3600, true);

      return new Response(
        JSON.stringify(
          {
            token_type: "Bearer",
            access_token: shortLived,
            expires_in: 15 * 60,
            refresh_token: refresh,
          },
          null,
          2
        ),
        { headers: { "content-type": "application/json" } }
      );
    } catch (err) {
      return new Response("Error: " + (err as Error).message, { status: 500 });
    }
  },

  /**
   * Exchange a refresh token for a new short-lived token.
   */
  async handleRefreshRequest(request: Request, env: Env): Promise<Response> {
    try {
      const body = await request.json<any>();
      const refreshToken = body?.refresh_token;
      if (!refreshToken) {
        return new Response("Missing refresh token", { status: 400 });
      }

      const tokenPayload = await verifyToken(refreshToken, env, true);
      if (!tokenPayload) {
        return new Response("Invalid or expired refresh token", { status: 401 });
      }

      const clientId = tokenPayload["client_id"];
      if (!isValidClientId(clientId as string, env)) {
        return new Response("Client ID no longer valid", { status: 401 });
      }

      const { signingKey, kid } = findCurrentSigningKey(env);
      if (!signingKey) {
        return new Response("No active signing key", { status: 500 });
      }

      const shortLived = await createSigner(signingKey, kid, clientId as string, 15 * 60);
      return new Response(
        JSON.stringify(
          {
            token_type: "Bearer",
            access_token: shortLived,
            expires_in: 15 * 60,
          },
          null,
          2
        ),
        { headers: { "content-type": "application/json" } }
      );
    } catch (err) {
      return new Response("Error: " + (err as Error).message, { status: 500 });
    }
  },

  /**
   * Retrieve data from the AemoData DO, must have a valid short-lived token (Bearer).
   * Now preserves pagination-related headers from the DO response.
   */
  async handleDataRequest(request: Request, env: Env): Promise<Response> {
    try {
      const authHeader = request.headers.get("authorization") || "";
      const match = authHeader.match(/^Bearer (.+)$/);
      if (!match) {
        return new Response("Missing or invalid Authorization header", { status: 401 });
      }
      const accessToken = match[1];
      const tokenPayload = await verifyToken(accessToken, env, false);
      if (!tokenPayload) {
        return new Response("Invalid or expired access token", { status: 401 });
      }

      const url = new URL(request.url);
      const qs = url.searchParams.toString();
      const id = env.AEMO_DATA.idFromName("AEMO_LOGGER");
      const stub = env.AEMO_DATA.get(id);

      const doResp = await stub.fetch(`https://dummy-url/range?${qs}`);
      if (!doResp.ok) {
        return new Response(await doResp.text(), { status: doResp.status });
      }

      // Clone the DO's response so that we preserve all headers (including pagination info)
      const newResp = new Response(doResp.body, {
        status: doResp.status,
        headers: new Headers(doResp.headers),
      });
      return newResp;
    } catch (err) {
      return new Response("Error: " + (err as Error).message, { status: 500 });
    }
  },
};

/**
 * Verifies that the given token is valid. If not, returns null.
 */
async function verifyToken(
  token: string,
  env: Env,
  isRefresh: boolean
): Promise<Record<string, unknown> | null> {
  return await createVerifier(token, env, isRefresh);
}

/**
 * Checks if the clientId is in the environment's CLIENT_IDS.
 */
function isValidClientId(clientId: string | undefined, env: Env): boolean {
  if (!clientId) return false;
  const raw = env.CLIENT_IDS || "";
  try {
    if (raw.trim().startsWith("[")) {
      const arr = JSON.parse(raw) as string[];
      return arr.includes(clientId);
    } else {
      return clientId === raw.trim();
    }
  } catch {
    return false;
  }
}

/**
 * Finds a key in env.SIGNING_KEYS that is active (using start/expire as Unix seconds),
 * returning the one with the newest .start.
 */
function findCurrentSigningKey(
  env: Env
): { signingKey?: string; kid?: string } {
  let keys: KeyDefinition[] = [];
  try {
    keys = JSON.parse(env.SIGNING_KEYS || "[]");
  } catch {
    // empty
  }
  const now = Date.now();
  let best: KeyDefinition | undefined;
  for (const k of keys) {
    if (k.revoked) continue;
    const startTime = (Number(k.start) || 0) * 1000;
    const endTime = (Number(k.expire) || 0) * 1000;
    if (startTime <= now && now < endTime) {
      if (!best) {
        best = k;
      } else {
        const bestStart = (Number(best.start) || 0) * 1000;
        if (startTime > bestStart) {
          best = k;
        }
      }
    }
  }
  if (!best) return {};
  return { signingKey: best.private, kid: best.id };
}

/**
 * Checks if the request is within rate limits. If not, returns {allowed: false}.
 */
async function checkRateLimit(
  request: Request,
  env: Env
): Promise<{ allowed: boolean }> {
  const nowMs = Date.now();
  const ip = request.headers.get("CF-Connecting-IP") || "UNKNOWN";
  const asn = request.headers.get("CF-ISP") || request.headers.get("cf-asn") || "UNKNOWN";
  const sessionId = getOrCreateSessionId(request);

  const id = env.API_ABUSE.idFromName("API_ABUSE_OBJECT");
  const stub = env.API_ABUSE.get(id);

  const resp = await stub.fetch("https://dummy-url/checkRate", {
    method: "POST",
    body: JSON.stringify({ ip, asn, session_id: sessionId, nowMs }),
    headers: { "content-type": "application/json" },
  });
  if (!resp.ok) {
    return { allowed: false };
  }
  return resp.json<{ allowed: boolean }>();
}

/**
 * Rudimentary session ID. For a real app, store/issue session IDs properly.
 */
function getOrCreateSessionId(request: Request): string {
  const cookie = request.headers.get("cookie") || "";
  const match = cookie.match(/sessionId=([^;]+)/);
  if (match) {
    return match[1];
  }
  return "no-session";
}

/** Helper to convert log level strings to numeric priority. */
function getLogPriority(level: string): number {
  switch (level.toUpperCase()) {
    case 'DEBUG': return 1;
    case 'INFO':  return 2;
    case 'WARN':  return 3;
    case 'ERROR': return 4;
    default:      return 99; // 'NONE' or unknown
  }
}

/**
 * Handle OPTIONS preflight. Returns a 204 response with CORS headers if the origin is allowed.
 */
function handleOptionsRequest(request: Request, env: Env): Response {
  const origin = request.headers.get("Origin") || "";
  const allowedOrigins = parseAllowedOrigins(env.APP_ALLOWED_ORIGINS || "[]");
  const resp = new Response(null, { status: 204 });

  // Always set Vary so that different Origin requests are not cached as one
  resp.headers.set("Vary", "Origin");

  if (allowedOrigins.includes(origin)) {
    resp.headers.set("Access-Control-Allow-Origin", origin);
  }
  resp.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  // You can adapt Allow-Headers as needed for your app
  resp.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  resp.headers.set("Access-Control-Max-Age", "86400");

  return resp;
}

/**
 * Adds the CORS headers to the final response if the request's Origin is in the allowed list.
 */
function addCorsHeaders(request: Request, env: Env, response: Response): Response {
  const origin = request.headers.get("Origin") || "";
  const allowedOrigins = parseAllowedOrigins(env.APP_ALLOWED_ORIGINS || "[]");
  if (allowedOrigins.includes(origin)) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Vary", "Origin");
  }
  return response;
}

/**
 * Parse the APP_ALLOWED_ORIGINS variable, which may be a JSON array string
 * or an empty/fallback string. Returns an array of domains.
 */
function parseAllowedOrigins(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((o) => String(o).trim()).filter(Boolean);
    }
    return [];
  } catch {
    return [];
  }
}

// Re-export DOs for Wrangler
export { AemoData } from "../AemoDataDurableObject";
export { ApiAbuse } from "./ApiAbuseDurableObject";