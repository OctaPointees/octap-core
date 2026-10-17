import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const WEBHOOK_SECRET_PREFIX = 'whsec_';

export function generateWebhookSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}${randomBytes(24).toString('hex')}`;
}

/** HMAC-SHA256 of the exact bytes that will be sent as the request body. */
export function signWebhookPayload(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/** Constant-time compare so verification can't leak the secret via response-time. */
export function verifyWebhookSignature(rawBody: string, signature: string, secret: string): boolean {
  const expected = signWebhookPayload(rawBody, secret);
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(signature, 'hex');
  return expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);
}
