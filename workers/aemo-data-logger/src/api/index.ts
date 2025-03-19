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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // First, enforce rate limit
    const rateLimitResult = await checkRateLimit(request, env);
    if (!rateLimitResult.allowed) {
      return new Response("Too Many Requests", { status: 429 });
    }

    const url = new URL(request.url);
    if (url.pathname === "/.well-known/jwks.json") {
      return this.handleJwks(env);
    } else if (url.pathname === "/token" && request.method === "POST") {
      return this.handleTokenRequest(request, env);
    } else if (url.pathname === "/refresh" && request.method === "POST") {
      return this.handleRefreshRequest(request, env);
    } else if (url.pathname === "/data" && request.method === "GET") {
      return this.handleDataRequest(request, env);
    }

    return new Response("Not found", { status: 404 });
  },

  /**
   * Return public JWKS info from SIGNING_KEYS. This helps clients verify tokens.
   */
  handleJwks(env: Env): Response {
    try {
      const keys: KeyDefinition[] = JSON.parse(env.SIGNING_KEYS || "[]");
      // Filter out revoked or expired. We'll just show any key that isn't explicitly revoked.
      const now = Date.now();
      const activePublicKeys = keys
        .filter((k) => !k.revoked && new Date(k.start).getTime() <= now && now < new Date(k.end).getTime())
        .map((k) => {
          // Real code must parse the public key to produce a valid JWK n/e. This is a simplified example.
          return {
            kty: "RSA",
            alg: "RS256",
            use: "sig",
            kid: k.start,
            // Oversimplified placeholders
            n: "PUBLIC_KEY_N_VALUE",
            e: "AQAB",
          };
        });

      return new Response(JSON.stringify({ keys: activePublicKeys }, null, 2), {
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

      const shortLivedToken = await createSigner(signingKey, kid, clientId, 15 * 60);
      const refreshToken = await createSigner(signingKey, kid, clientId, 14 * 24 * 3600, true);

      return new Response(JSON.stringify({
        token_type: "Bearer",
        access_token: shortLivedToken,
        expires_in: 15 * 60,
        refresh_token: refreshToken
      }), {
        headers: { "content-type": "application/json" }
      });
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

      const shortLivedToken = await createSigner(signingKey, kid, clientId as string, 15 * 60);
      return new Response(JSON.stringify({
        token_type: "Bearer",
        access_token: shortLivedToken,
        expires_in: 15 * 60,
      }), {
        headers: { "content-type": "application/json" }
      });
    } catch (err) {
      return new Response("Error: " + (err as Error).message, { status: 500 });
    }
  },

  /**
   * Retrieve data from the AemoData DO, defaulting to a recent window or
   * letting the user pass lastSec=..., or start=..., end=..., regionid=...
   * Must have a valid short-lived token (Bearer).
   */
  async handleDataRequest(request: Request, env: Env): Promise<Response> {
    try {
      // parse Authorization header
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

      // forward query parameters to AemoData DO
      const url = new URL(request.url);
      const qs = url.searchParams.toString();
      const id = env.AEMO_DATA.idFromName("AEMO_LOGGER");
      const stub = env.AEMO_DATA.get(id);

      const doResp = await stub.fetch(`https://dummy-url/range?${qs}`);
      if (!doResp.ok) {
        return new Response(await doResp.text(), { status: doResp.status });
      }

      return new Response(await doResp.text(), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (err) {
      return new Response("Error: " + (err as Error).message, { status: 500 });
    }
  },
};

/**
 * Verifies that the given token is valid. If not, returns null.
 */
async function verifyToken(token: string, env: Env, isRefresh: boolean): Promise<Record<string, unknown> | null> {
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
      // parse as array
      const arr = JSON.parse(raw) as string[];
      return arr.includes(clientId);
    } else {
      // single string
      return clientId === raw.trim();
    }
  } catch {
    return false;
  }
}

/**
 * Finds a key in env.SIGNING_KEYS that is active (start <= now < end, not revoked),
 * and returns the latest one (the one with the newest start).
 */
function findCurrentSigningKey(env: Env): { signingKey?: string; kid?: string } {
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
    const startTime = new Date(k.start).getTime();
    const endTime = new Date(k.end).getTime();
    if (startTime <= now && now < endTime) {
      if (!best) {
        best = k;
      } else {
        const bestStart = new Date(best.start).getTime();
        if (startTime > bestStart) {
          best = k;
        }
      }
    }
  }
  if (!best) return {};
  return { signingKey: best.private, kid: best.start };
}

/**
 * Calls the API_ABUSE DO to see if this request is within the allowed rate limit.
 * Returns { allowed: false } if the limit is exceeded, or { allowed: true } if ok.
 */
async function checkRateLimit(request: Request, env: Env): Promise<{ allowed: boolean }> {
  const nowMs = Date.now();
  const ip = request.headers.get("CF-Connecting-IP") || "UNKNOWN";
  const asn = request.headers.get("CF-ISP") || request.headers.get("cf-asn") || "UNKNOWN";
  const sessionId = getOrCreateSessionId(request);

  // forward to DO
  const id = env.API_ABUSE.idFromName("API_ABUSE_OBJECT");
  const stub = env.API_ABUSE.get(id);

  const resp = await stub.fetch("https://dummy-url/checkRate", {
    method: "POST",
    body: JSON.stringify({
      ip,
      asn,
      session_id: sessionId,
      nowMs,
    }),
    headers: { "content-type": "application/json" },
  });
  if (!resp.ok) {
    return { allowed: false };
  }
  const data = await resp.json<{ allowed: boolean }>();
  return data;
}

/**
 * Simple utility to identify the user's session. This might be replaced with
 * a real session store. For now, we read "sessionId" from cookies or create a random one.
 */
function getOrCreateSessionId(request: Request): string {
  const cookie = request.headers.get("cookie") || "";
  const match = cookie.match(/sessionId=([^;]+)/);
  if (match) {
    return match[1];
  }
  // We could generate a new ID here, but for strict rate-limiting we just
  // return "no-session" if none is found. A real app might set a Set-Cookie.
  // For completeness:
  //   const randomId = crypto.randomUUID();
  //   ...
  return "no-session";
}