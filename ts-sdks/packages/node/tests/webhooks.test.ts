import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyWebhookSignature } from '../src/index.js';

const sign = (body: string, secret: string) => createHmac('sha256', secret).update(body).digest('hex');

describe('verifyWebhookSignature', () => {
  it('accepts the HMAC-SHA256 of the exact raw body, and nothing else', () => {
    const body = '{"id":"evt-1","type":"credits.earned"}';
    const signature = sign(body, 'whsec_test');

    expect(verifyWebhookSignature(body, signature, 'whsec_test')).toBe(true);
    expect(verifyWebhookSignature('{"type":"credits.earned","id":"evt-1"}', signature, 'whsec_test')).toBe(false);
    expect(verifyWebhookSignature(body, signature, 'whsec_other')).toBe(false);
    expect(verifyWebhookSignature(body, signature.slice(0, 10), 'whsec_test')).toBe(false);
    expect(verifyWebhookSignature(body, '', 'whsec_test')).toBe(false);
  });
});
