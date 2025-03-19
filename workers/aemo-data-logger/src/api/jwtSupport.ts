/**
 * @fileoverview JWT creation and verification using the 'jsonwebtoken' library.
 * Must be installed as a dependency. Uses RS256 with provided RSA key pairs.
 */
import jwt from "jsonwebtoken";
import { Env, KeyDefinition } from "./types";

/**
 * Decodes a base64-encoded PEM string into its original ASCII-based PEM format.
 * This ensures our private or public key includes the "-----BEGIN ...-----" lines
 * needed for RS256 operations.
 *
 * @param {string} b64 A base64-encoded string containing an entire PEM file.
 * @return {string} The decoded ASCII PEM contents, including BEGIN/END lines.
 */
function decodeBase64Pem(b64: string): string {
  return atob(b64);
}

/**
 * Sign a JWT with RS256, using the given private key PEM. The keyid is set to the unique "kid".
 *
 * @param {string} privateKeyPem A base64-encoded string representing the complete PEM file.
 * @param {string} kid The key ID associated with this RSA key.
 * @param {string} clientId The client identifier. Placed inside the token payload.
 * @param {number} expiresInSeconds Lifetime in seconds for the token.
 * @param {boolean} [isRefresh=false] Whether this token is a refresh token.
 * @return {Promise<string>} A promise that resolves to the signed JWT.
 */
export async function createSigner(
  privateKeyPem: string,
  kid: string,
  clientId: string,
  expiresInSeconds: number,
  isRefresh = false
): Promise<string> {
  const decodedPrivateKey = decodeBase64Pem(privateKeyPem);
  const payload = {
    client_id: clientId,
    isRefresh,
  };
  return jwt.sign(payload, decodedPrivateKey, {
    algorithm: "RS256",
    keyid: kid,
    expiresIn: expiresInSeconds,
  });
}

/**
 * Verify an incoming token. If valid, returns its decoded payload. If invalid, returns null.
 *
 * @param {string} token The JWT to verify.
 * @param {Env} env Environment variables including SIGNING_KEYS etc.
 * @param {boolean} isRefresh Whether we expect this token to be a refresh token.
 * @return {Promise<Record<string, unknown> | null>} The decoded payload or null if verification fails.
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
    const decodedPublicKey = decodeBase64Pem(candidate.public);
    const verified = jwt.verify(token, decodedPublicKey, {
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
 *
 * @param {string} token A standard JWT in the form header.payload.signature
 * @return {{ kid?: string } | null} Object containing the kid or null if missing.
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