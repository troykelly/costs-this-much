/**
 * @fileoverview JWT creation and verification using the Web Crypto API in Cloudflare Workers.
 * Must use RS256 with provided RSA key pairs in PEM format under Cloudflare’s WebCrypto.
 */

import { Env, KeyDefinition } from "./types";

/**
 * Decodes a base64-encoded PEM string into its original ASCII-based PEM format.
 * This ensures our private or public key includes the "-----BEGIN ...-----" lines
 * needed for RS256 operations in Web Crypto.
 *
 * @param {string} b64 A base64-encoded string containing an entire PEM file.
 * @return {string} The decoded ASCII PEM contents, including BEGIN/END lines.
 */
function decodeBase64Pem(b64: string): string {
  return atob(b64);
}

/**
 * Convert an ASCII PEM string into a Uint8Array by stripping the PEM headers
 * and footers, then base64-decoding the remaining content.
 *
 * @param {string} pem The ASCII PEM string (including BEGIN/END headers).
 * @return {Uint8Array} Decoded binary data for the key.
 */
function pemToBinary(pem: string): Uint8Array {
  // Remove the PEM header and footer lines, plus whitespace
  let contents = pem.trim();
  contents = contents.replace(/-----BEGIN [A-Z ]+-----/g, "");
  contents = contents.replace(/-----END [A-Z ]+-----/g, "");
  contents = contents.replace(/\s+/g, "");
  return Uint8Array.from(atob(contents), (c) => c.charCodeAt(0));
}

/**
 * Import an RSA private key from ASCII PEM text for RSASSA-PKCS1-v1_5, SHA-256.
 *
 * @param {string} asciiPem ASCII-based PEM text (including BEGIN/END headers).
 * @return {Promise<CryptoKey>} A promise that resolves to a CryptoKey usable for signing.
 */
async function importRsaPrivateKey(asciiPem: string): Promise<CryptoKey> {
  const binaryKey = pemToBinary(asciiPem);
  return crypto.subtle.importKey(
    "pkcs8",
    binaryKey.buffer,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: { name: "SHA-256" },
    },
    true,
    ["sign"]
  );
}

/**
 * Import an RSA public key from ASCII PEM text for RSASSA-PKCS1-v1_5, SHA-256.
 *
 * @param {string} asciiPem ASCII-based PEM text (including BEGIN/END headers).
 * @return {Promise<CryptoKey>} A promise that resolves to a CryptoKey usable for signature verification.
 */
async function importRsaPublicKey(asciiPem: string): Promise<CryptoKey> {
  const binaryKey = pemToBinary(asciiPem);
  return crypto.subtle.importKey(
    "spki",
    binaryKey.buffer,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: { name: "SHA-256" },
    },
    true,
    ["verify"]
  );
}

/**
 * Encode a string (or binary) to base64url (RFC4648).
 *
 * @param {string | Uint8Array} data The data to encode.
 * @return {string} Base64url-encoded string.
 */
function encodeBase64Url(data: string | Uint8Array): string {
  let str: string;
  if (typeof data === "string") {
    str = btoa(data);
  } else {
    let binary = "";
    for (let i = 0; i < data.length; i++) {
      binary += String.fromCharCode(data[i]);
    }
    str = btoa(binary);
  }
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * Decode a base64url string into a Uint8Array.
 *
 * @param {string} base64url The base64url-encoded string.
 * @return {Uint8Array} The decoded data.
 */
function decodeBase64Url(base64url: string): Uint8Array {
  // Convert base64url to standard base64.
  let base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  // Pad with '=' if necessary.
  const pad = base64.length % 4;
  if (pad) {
    base64 += "=".repeat(4 - pad);
  }
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    out[i] = raw.charCodeAt(i);
  }
  return out;
}

/**
 * Decode a base64url string into its UTF-8 text representation.
 *
 * @param {string} base64url The base64url-encoded string.
 * @return {string} Decoded text.
 */
function decodeUtf8(base64url: string): string {
  const bytes = decodeBase64Url(base64url);
  return new TextDecoder().decode(bytes);
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
  // Convert base64 to ASCII PEM
  const asciiPem = decodeBase64Pem(privateKeyPem);
  const privateKey = await importRsaPrivateKey(asciiPem);

  // Construct the standard JWT header & payload
  const header = {
    alg: "RS256",
    typ: "JWT",
    kid,
  };
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + expiresInSeconds;
  const payload = {
    client_id: clientId,
    isRefresh,
    iat,
    exp,
  };

  // Encode the header and payload as base64url
  const headerB64 = encodeBase64Url(JSON.stringify(header));
  const payloadB64 = encodeBase64Url(JSON.stringify(payload));

  // Create the signature on header + "." + payload
  const message = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signatureBuffer = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    privateKey,
    message
  );
  const signatureB64 = encodeBase64Url(new Uint8Array(signatureBuffer));

  return `${headerB64}.${payloadB64}.${signatureB64}`;
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
  // Examine the header first
  const decodedHeader = decodeJwtHeader(token);
  if (!decodedHeader?.kid) {
    return null;
  }

  // Find a matching key that is active
  let keys: KeyDefinition[];
  try {
    keys = JSON.parse(env.SIGNING_KEYS || "[]");
  } catch {
    return null;
  }

  const now = Date.now();
  const candidate = keys.find((k) => {
    const startTime = (Number(k.start) || 0) * 1000;
    const expireTime = (Number(k.expire) || 0) * 1000;
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

  // Parse out the three JWT segments
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signatureB64] = parts;
  // Re-import the public key
  const asciiPub = decodeBase64Pem(candidate.public);
  const publicKey = await importRsaPublicKey(asciiPub);

  // Verify the signature
  const message = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = decodeBase64Url(signatureB64);
  let isValid = false;
  try {
    isValid = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      publicKey,
      signature,
      message
    );
  } catch {
    return null;
  }
  if (!isValid) return null;

  // If signature is valid, parse payload and check iat/exp, isRefresh
  let payloadJson: Record<string, unknown>;
  try {
    const rawPayload = decodeUtf8(payloadB64);
    payloadJson = JSON.parse(rawPayload);
  } catch {
    return null;
  }

  // Verify expiry etc.
  const nowSec = Math.floor(Date.now() / 1000);
  const tokenIat = Number(payloadJson.iat) || 0;
  const tokenExp = Number(payloadJson.exp) || 0;
  if (tokenIat > nowSec || tokenExp < nowSec) {
    return null;
  }

  // Check isRefresh
  if (payloadJson.isRefresh !== isRefresh) {
    return null;
  }

  return payloadJson;
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