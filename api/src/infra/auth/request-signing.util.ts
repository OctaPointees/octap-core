import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** A request older or newer than this (clock skew + network delay) is rejected as stale. */
export const REPLAY_WINDOW_SECONDS = 300;

export function hashBody(rawBody: string): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

/**
 * The exact bytes every signature covers: method, path (with query string), unix-seconds
 * timestamp, a per-request nonce, and the request body's hash. Order and the newline
 * separator are part of the contract — changing either breaks every existing signer.
 */
export function buildCanonicalRequest(params: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  rawBody: string;
}): string {
  return `${params.method.toUpperCase()}\n${params.path}\n${params.timestamp}\n${params.nonce}\n${hashBody(params.rawBody)}`;
}

/**
 * `signingKey` is the credential's `keyHash` (already stored, SHA-256 of the raw API key) —
 * never a separate secret. A client derives the same value locally by hashing the raw key
 * it already holds, so no new secret needs to be issued, stored, or rotated out of band.
 */
export function signCanonicalRequest(canonical: string, signingKey: string): string {
  return createHmac('sha256', signingKey).update(canonical).digest('hex');
}

export function verifyCanonicalSignature(canonical: string, signature: string, signingKey: string): boolean {
  const expected = signCanonicalRequest(canonical, signingKey);
  let expectedBuf: Buffer;
  let actualBuf: Buffer;
  try {
    expectedBuf = Buffer.from(expected, 'hex');
    actualBuf = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  return expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);
}

export function isTimestampFresh(timestampSeconds: number, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  return Math.abs(nowSeconds - timestampSeconds) <= REPLAY_WINDOW_SECONDS;
}
