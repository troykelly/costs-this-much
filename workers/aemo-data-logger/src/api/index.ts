/**
 * @fileoverview Minimal scaffolding for an API Worker that issues short-lived JWTs,
 * refresh tokens, and provides a data endpoint, plus .well-known jwks.
 *
 * Note: Implementation details (JWT signing, client ID checks, key rotation, data retrieval)
 * are left for you to complete. This is only a structural scaffold.
 */
import { createSigner, createVerifier } from './jwtSupport';
import { Env, KeyDefinition } from './types';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/.well-known/jwks.json') {
      return this.handleJwks(env);
    }

    if (url.pathname === '/token' && request.method === 'POST') {
      return this.handleTokenRequest(request, env);
    }

    if (url.pathname === '/refresh' && request.method === 'POST') {
      return this.handleRefreshRequest(request, env);
    }

    if (url.pathname === '/data' && request.method === 'GET') {
      return this.handleDataRequest(request, env);
    }

    return new Response("Not found", { status: 404 });
  },

  // Stub: Return public JWKS info from SIGNING_KEYS
  handleJwks(env: Env): Response {
    try {
      const keys: KeyDefinition[] = JSON.parse(env.SIGNING_KEYS || "[]");
      const activePublicKeys = keys
        .filter(k => !k.revoked)
        .map(k => {
          // Here you'd parse the actual public key into a JWK structure
          // For scaffolding, we do a simplified example:
          return {
            kty: "RSA",
            alg: "RS256",
            use: "sig",
            // an oversimplified representation - real code must parse the actual key to produce a JWK
            n: "PUBLIC_KEY_N_VALUE",
            e: "AQAB",
            kid: k.start,
          };
        });
      return new Response(JSON.stringify({ keys: activePublicKeys }, null, 2), {
        headers: { "content-type": "application/json" },
      });
    } catch (err) {
      return new Response("Error constructing JWKS: " + (err as Error).message, { status: 500 });
    }
  },

  // Stub: Issue short-lived token and refresh token
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

      // Issue short-lived (e.g., 15min) token
      const shortLivedToken = await createSigner(signingKey, kid, clientId, 15 * 60); 
      // Issue refresh token (e.g., 14 days)
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

  // Stub: Exchange refresh token for new short-lived token
  async handleRefreshRequest(request: Request, env: Env): Promise<Response> {
    try {
      const body = await request.json<any>();
      const refreshToken = body?.refresh_token;
      if (!refreshToken) {
        return new Response("Missing refresh token", { status: 400 });
      }

      // Verify refresh token
      const tokenPayload = await verifyToken(refreshToken, env, true);
      if (!tokenPayload) {
        return new Response("Invalid or expired refresh token", { status: 401 });
      }
      const clientId = tokenPayload["client_id"];
      if (!isValidClientId(clientId, env)) {
        return new Response("Client ID is no longer valid", { status: 401 });
      }

      const { signingKey, kid } = findCurrentSigningKey(env);
      if (!signingKey) {
        return new Response("No active signing key", { status: 500 });
      }

      // Issue new short-lived token
      const shortLivedToken = await createSigner(signingKey, kid, clientId, 15 * 60);

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

  // Stub: Retrieve data up to 31d if user supplies. 
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

      // parse query e.g. ?days=7
      const url = new URL(request.url);
      let days = parseInt(url.searchParams.get("days") || "7", 10);
      if (isNaN(days) || days < 1) days = 7;
      if (days > 31) days = 31;

      // imaginary retrieval from AEMO data DO or store
      // e.g. const data = retrieveDataFromDO(days);
      const data = {
        message: `Some ${days}-day 5-minute data goes here (stub).`
      };

      return new Response(JSON.stringify(data, null, 2), {
        headers: { "content-type": "application/json" }
      });
    } catch (err) {
      return new Response("Error: " + (err as Error).message, { status: 500 });
    }
  },
};

// -- Helpers:

function isValidClientId(clientId: string, env: Env): boolean {
  if (!clientId) return false;
  let validList = env.CLIENT_IDS || "";
  try {
    if (validList.trim().startsWith("[")) {
      // parse as array
      const arr = JSON.parse(validList) as string[];
      return arr.includes(clientId);
    } else {
      // single string
      return (clientId === validList.trim());
    }
  } catch {
    // fallback
    return (clientId === validList.trim());
  }
}

function findCurrentSigningKey(env: Env): { signingKey?: string, kid?: string } {
  let keys: KeyDefinition[] = [];
  try {
    keys = JSON.parse(env.SIGNING_KEYS || "[]");
  } catch {}
  // find the key with highest start date that is not revoked and is still in range
  let best: KeyDefinition | undefined;
  for (const k of keys) {
    if (k.revoked) continue;
    const startTime = new Date(k.start).getTime();
    const endTime = new Date(k.end).getTime();
    const now = Date.now();
    if (startTime <= now && now < endTime) {
      // candidate
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

async function verifyToken(token: string, env: Env, isRefresh: boolean): Promise<any | null> {
  // Example: parse env keys, verify token. We'll bubble up errors if invalid
  // For scaffolding, we just do a pseudo check. Real code: parse the header kid, find in env, verify.
  return await createVerifier(token, env, isRefresh);
}