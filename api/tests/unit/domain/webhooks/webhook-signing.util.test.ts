import { describe, expect, it } from 'vitest';
import { verifyWebhookSignature as sdkVerifyWebhookSignature } from '@octap/sdk';
import {
  WEBHOOK_SECRET_PREFIX,
  generateWebhookSecret,
  signWebhookPayload,
  verifyWebhookSignature,
} from '#domain/webhooks/webhook-signing.util.js';

describe('webhook-signing', () => {
  it('generates distinct, prefixed secrets', () => {
    const a = generateWebhookSecret();
    expect(a.startsWith(WEBHOOK_SECRET_PREFIX)).toBe(true);
    expect(a).toHaveLength(WEBHOOK_SECRET_PREFIX.length + 48);
    expect(generateWebhookSecret()).not.toBe(a);
  });

  it('a valid signature verifies and a tampered body, wrong secret, or wrong length does not', () => {
    const secret = generateWebhookSecret();
    const body = JSON.stringify({ id: 'evt-1', type: 'credits.earned' });
    const signature = signWebhookPayload(body, secret);

    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(body, signature, secret)).toBe(true);
    expect(verifyWebhookSignature(`${body} `, signature, secret)).toBe(false);
    expect(verifyWebhookSignature(body, signature, generateWebhookSecret())).toBe(false);
    expect(verifyWebhookSignature(body, signature.slice(0, 32), secret)).toBe(false);
  });

  it('the server util and the Node SDK verifier agree (cross-package)', () => {
    const secret = generateWebhookSecret();
    const body = JSON.stringify({ id: 'evt-2', type: 'credits.redeemed' });
    const signature = signWebhookPayload(body, secret);

    expect(sdkVerifyWebhookSignature(body, signature, secret)).toBe(true);
    expect(sdkVerifyWebhookSignature(body, 'not-hex-but-also-wrong', secret)).toBe(false);
  });
});
