import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OctaSdkError, constructWebhookEvent, verifyWebhookSignature } from '../src/index.js';

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

describe('constructWebhookEvent (OCT-209)', () => {
  const body = JSON.stringify({
    id: 'evt-confirm-1',
    type: 'credits.earn.confirmed',
    data: {
      transactionId: 'tx-1',
      organizationEndUserId: 'user-1',
      pointsAmount: 100,
      newBalance: 200,
      blockchainDigest: 'DIGEST1',
    },
  });

  it('verifies the signature and returns the typed event', () => {
    const event = constructWebhookEvent(body, sign(body, 'whsec_test'), 'whsec_test');

    expect(event.type).toBe('credits.earn.confirmed');
    if (event.type === 'credits.earn.confirmed') {
      expect(event.data.blockchainDigest).toBe('DIGEST1');
      expect(event.data.newBalance).toBe(200);
    }
  });

  it('throws OctaSdkError for a missing, wrong, or stale signature instead of returning an event', () => {
    expect(() => constructWebhookEvent(body, undefined, 'whsec_test')).toThrow(OctaSdkError);
    expect(() => constructWebhookEvent(body, sign(body, 'whsec_other'), 'whsec_test')).toThrow(
      /Invalid OctaP webhook signature/,
    );
    expect(() => constructWebhookEvent(`${body} `, sign(body, 'whsec_test'), 'whsec_test')).toThrow(OctaSdkError);
  });
});
