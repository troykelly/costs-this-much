/**
 * @fileoverview JWT creation and verification using the 'jsonwebtoken' library.
 * Must be installed as a dependency. Uses RS256 with provided RSA key pairs.
 */
import jwt from "jsonwebtoken";
import { Env, KeyDefinition } from "./types";

/**
 * createSigner signs a token with the given key for the given client ID,
 * attaching e.g. "exp" for expiry, "kid" for key ID, etc.
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
 * createVerifier: parse the JWT, use the matching public key
 * from the environment, verify signature, check exp, etc.
 *
 * If invalid, returns null or throws. If valid, returns the decoded payload object.
 */
export async function createVerifier(
  token: string,
  env: Env,
  isRefresh: boolean
): Promise<Record<string, unknown> | null> {
  // Decode header to find 'kid'
  const decodedHeader = decodeJwtHeader(token);
  if (!decodedHeader || !decodedHeader.kid) {
    return null;
  }

  const kidFromToken = decodedHeader.kid;
  let keys: KeyDefinition[] = [];
  try {
    keys = JSON.parse(env.SIGNING_KEYS || "[]");
  } catch {
    return null;
  }

  const now = Date.now();
  const candidate = keys.find((k) => {
    // Interpret start and expire as Unix seconds
    const startTime = (k.start ?? 0) * 1000;
    const expireTime = (k.expire ?? 0) * 1000;
    return (
      k.id === kidFromToken &&
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

    if (verified.isRefresh !== isRefresh) {
      return null;
    }
    return verified;
  } catch {
    return null;
  }
}

/**
 * A quick way to decode a JWT header only, without verifying.
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