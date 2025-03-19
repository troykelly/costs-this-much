/**
 * @fileoverview JWT creation and verification using the 'jsonwebtoken' library.
 * Must be installed as a dependency. Uses RS256 with provided RSA key pairs.
 */
import jwt from "jsonwebtoken";
import { Env, KeyDefinition } from "./types";

/**
 * Sign a JWT with RS256, using the given private key PEM. The keyid is set to the unique "kid".
 */
export async function createSigner(
  privateKeyPem: string,
  kid: string,
  clientId: string,
  expiresInSeconds: number,
  isRefresh = false
): Promise<string> {
  const payload = {
    client_id: clientId,
    isRefresh,
  };
  return jwt.sign(payload, privateKeyPem, {
    algorithm: "RS256",
    keyid: kid,
    expiresIn: expiresInSeconds,
  });
}

/**
 * Verify an incoming token. If valid, return its decoded payload. If invalid, return null.
 */
export async function createVerifier(
  token: string,
  env: Env,
  isRefresh: boolean
): Promise<Record<string, unknown> | null> {
  const decodedHeader = decodeJwtHeader(token);
  if (!decodedHeader?.kid) {
    return null;
  }

  let keys: KeyDefinition[];
  try {
    keys = JSON.parse(env.SIGNING_KEYS || "[]");
  } catch {
    return null;
  }

  const now = Date.now();
  // Find a matching key that is active
  const candidate = keys.find((k) => {
    const startTime = (k.start ?? 0) * 1000;
    const expireTime = (k.expire ?? 0) * 1000;
    return (
      k.id === decodedHeader.kid &&
      !k.revoked &&
      startTime <= now &&
      now < expireTime
    );
  });

  if (!candidate) {
    return null;
  }

  try {
    const verified = jwt.verify(token, candidate.public, {
      algorithms: ["RS256"],
    }) as Record<string, unknown>;

    // Check whether token's isRefresh matches what we expect
    return verified.isRefresh === isRefresh ? verified : null;
  } catch {
    return null;
  }
}

/**
 * Parse the token's header only (unverified) to get 'kid'. Null if malformed.
 */
function decodeJwtHeader(token: string): { kid?: string } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const headerJson = JSON.parse(atob(parts[0]));
    return headerJson;
  } catch {
    return null;
  }
}