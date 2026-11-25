import { describe, expect, it } from 'vitest';
import type { OrganizationEventSubject } from '@octap/contracts';
import { toStreamEvent } from '#domain/events/event-subjects.js';
import { sseControl, sseEvent, sseHeartbeat, sseRetry } from '#domain/events/sse.js';
import type { OrganizationEvent } from '#infra/db/repositories/events.repository.js';

const row = (type: string, payload: Record<string, unknown>): OrganizationEvent => ({
  id: 'evt-1',
  sequence: 42,
  organizationId: 'org-1',
  type,
  payload,
  createdAt: new Date('2026-11-25T10:00:00Z'),
});

describe('toStreamEvent', () => {
  it('carries ids and the subject, never the payload', () => {
    const event = toStreamEvent(
      row('voucher.submitted', { voucherId: 'v-1', batchId: 'b-1', title: 'Coffee', approvalRequestId: 'r-1' }),
    );
    expect(event).toEqual({
      id: 'evt-1',
      sequence: 42,
      type: 'voucher.submitted',
      subject: { kind: 'voucher', id: 'v-1', batchId: 'b-1' },
      occurredAt: '2026-11-25T10:00:00.000Z',
    });
  });

  it.each<[string, Record<string, unknown>, OrganizationEventSubject]>([
    ['voucher.created', { voucherId: 'v', batchId: null }, { kind: 'voucher', id: 'v', batchId: null }],
    ['voucher.returned', { voucherId: 'v', batchId: null }, { kind: 'voucher', id: 'v', batchId: null }],
    ['voucher.activated', { voucherId: 'v', batchId: null }, { kind: 'voucher', id: 'v', batchId: null }],
    ['voucher.publish.failed', { voucherId: 'v', batchId: null }, { kind: 'voucher', id: 'v', batchId: null }],
    ['voucher.paused', { voucherId: 'v', batchId: null }, { kind: 'voucher', id: 'v', batchId: null }],
    ['voucher.archived', { voucherId: 'v', batchId: 'b' }, { kind: 'voucher', id: 'v', batchId: 'b' }],
    [
      'voucher.granted',
      { voucherOwnershipId: 'o', voucherId: 'v', organizationEndUserId: 'm' },
      { kind: 'voucherOwnership', id: 'o', voucherId: 'v', memberId: 'm' },
    ],
    [
      'voucher.redeemed',
      { voucherOwnershipId: 'o', voucherId: 'v', organizationEndUserId: 'm' },
      { kind: 'voucherOwnership', id: 'o', voucherId: 'v', memberId: 'm' },
    ],
    ...['credits.earned', 'credits.earn.confirmed', 'credits.earn.failed', 'credits.redemption.confirmed'].map(
      (type) =>
        [
          type,
          { transactionId: 't', organizationEndUserId: 'm' },
          { kind: 'loyaltyTransaction', id: 't', memberId: 'm' },
        ] as [string, Record<string, unknown>, OrganizationEventSubject],
    ),
    [
      'credits.reversed',
      { reversalTransactionId: 'r', reversedTransactionId: 't', organizationEndUserId: 'm' },
      { kind: 'loyaltyTransaction', id: 'r', memberId: 'm' },
    ],
    ['budget.low', { threshold: 80 }, { kind: 'issuanceBudget' }],
  ])('%s reports its subject', (type, payload, subject) => {
    expect(toStreamEvent(row(type, payload))?.subject).toEqual(subject);
  });

  it('skips a type this build does not know, instead of guessing', () => {
    expect(toStreamEvent(row('member.invited', { memberId: 'm' }))).toBeNull();
  });
});

describe('SSE framing', () => {
  it('sends the sequence as the id, the type as the event, the message as data', () => {
    const event = toStreamEvent(row('voucher.paused', { voucherId: 'v', batchId: null }))!;
    expect(sseEvent(event)).toBe(`id: 42\nevent: voucher.paused\ndata: ${JSON.stringify(event)}\n\n`);
  });

  it('control messages, heartbeats and the retry hint carry no id', () => {
    expect(sseControl('stream.reset')).toBe('event: stream.reset\ndata: {}\n\n');
    expect(sseHeartbeat()).toBe(': ping\n\n');
    expect(sseRetry()).toBe('retry: 3000\n\n');
  });
});
