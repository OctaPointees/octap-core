import { createHash, randomBytes } from 'node:crypto';

/**
 * Raw keys are never stored. Only their SHA-256 hash and a short, non-secret
 * prefix (for display in dashboards) are persisted in `api_credentials`.
 */
export const API_KEY_PREFIX = 'octap_live_';
/** A sandbox key (OCT-297) reads as one at a glance, in code, logs and a leaked-secret scan. */
export const SANDBOX_API_KEY_PREFIX = 'octap_test_';

export interface GeneratedApiKey {
  raw: string;
  prefix: string;
  hash: string;
}

export function generateApiKey(environment: 'LIVE' | 'SANDBOX' = 'LIVE'): GeneratedApiKey {
  const keyPrefix = environment === 'SANDBOX' ? SANDBOX_API_KEY_PREFIX : API_KEY_PREFIX;
  const raw = `${keyPrefix}${randomBytes(24).toString('hex')}`;
  return { raw, prefix: raw.slice(0, keyPrefix.length + 8), hash: hashApiKey(raw) };
}

export function hashApiKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}
