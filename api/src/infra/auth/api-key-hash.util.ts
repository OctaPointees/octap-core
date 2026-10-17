import { createHash, randomBytes } from 'node:crypto';

/**
 * Raw keys are never stored. Only their SHA-256 hash and a short, non-secret
 * prefix (for display in dashboards) are persisted in `api_credentials`.
 */
export const API_KEY_PREFIX = 'octap_live_';

export interface GeneratedApiKey {
  raw: string;
  prefix: string;
  hash: string;
}

export function generateApiKey(): GeneratedApiKey {
  const raw = `${API_KEY_PREFIX}${randomBytes(24).toString('hex')}`;
  return { raw, prefix: raw.slice(0, API_KEY_PREFIX.length + 8), hash: hashApiKey(raw) };
}

export function hashApiKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}
