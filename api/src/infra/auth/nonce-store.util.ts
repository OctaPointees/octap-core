import type { Redis } from 'ioredis';
import { REPLAY_WINDOW_SECONDS } from './request-signing.util.js';

/**
 * Atomically claims a (credential, nonce) pair for the replay window. Returns false both when
 * the nonce was already used (a real replay) and when Redis itself is unreachable — the two
 * cases a caller must treat identically: fail closed, never silently skip replay protection.
 */
export async function claimNonce(redis: Redis, credentialId: string, nonce: string): Promise<boolean> {
  try {
    const result = await redis.set(`nonce:${credentialId}:${nonce}`, '1', 'EX', REPLAY_WINDOW_SECONDS, 'NX');
    return result === 'OK';
  } catch {
    return false;
  }
}
