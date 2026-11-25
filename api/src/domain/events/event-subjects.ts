import type {
  OrganizationEventSubject,
  OrganizationStreamEvent,
  WebhookEventData,
  WebhookEventType,
} from '@octap/contracts';
import type { OrganizationEvent } from '#infra/db/repositories/events.repository.js';

type SubjectOf = { [T in WebhookEventType]: (data: WebhookEventData<T>) => OrganizationEventSubject };

const voucher = (data: { voucherId: string; batchId: string | null }): OrganizationEventSubject => ({
  kind: 'voucher',
  id: data.voucherId,
  batchId: data.batchId,
});

/**
 * What each event type is about. Typed over every `WebhookEventType`, so a new event type does not
 * compile until it says which subject it reports, and then reaches the console stream on its own.
 */
const SUBJECT_OF: SubjectOf = {
  'credits.earned': (data) => ({
    kind: 'loyaltyTransaction',
    id: data.transactionId,
    memberId: data.organizationEndUserId,
  }),
  'credits.earn.confirmed': (data) => ({
    kind: 'loyaltyTransaction',
    id: data.transactionId,
    memberId: data.organizationEndUserId,
  }),
  'credits.earn.failed': (data) => ({
    kind: 'loyaltyTransaction',
    id: data.transactionId,
    memberId: data.organizationEndUserId,
  }),
  'credits.redemption.confirmed': (data) => ({
    kind: 'loyaltyTransaction',
    id: data.transactionId,
    memberId: data.organizationEndUserId,
  }),
  'credits.reversed': (data) => ({
    kind: 'loyaltyTransaction',
    id: data.reversalTransactionId,
    memberId: data.organizationEndUserId,
  }),
  'voucher.granted': (data) => ({
    kind: 'voucherOwnership',
    id: data.voucherOwnershipId,
    voucherId: data.voucherId,
    memberId: data.organizationEndUserId,
  }),
  'voucher.redeemed': (data) => ({
    kind: 'voucherOwnership',
    id: data.voucherOwnershipId,
    voucherId: data.voucherId,
    memberId: data.organizationEndUserId,
  }),
  'voucher.created': voucher,
  'voucher.submitted': voucher,
  'voucher.returned': voucher,
  'voucher.activated': voucher,
  'voucher.publish.failed': voucher,
  'voucher.paused': voucher,
  'voucher.archived': voucher,
  'budget.low': () => ({ kind: 'issuanceBudget' }),
};

/**
 * The stream's message for `event`: its ids and subject, never its payload. `null` for a type this
 * build does not know (recorded by a newer deployment during a rollout): skipped, not guessed at.
 */
export function toStreamEvent(event: OrganizationEvent): OrganizationStreamEvent | null {
  const subjectOf = SUBJECT_OF[event.type as WebhookEventType] as
    ((data: unknown) => OrganizationEventSubject) | undefined;
  if (!subjectOf) return null;
  return {
    id: event.id,
    sequence: event.sequence,
    type: event.type as WebhookEventType,
    subject: subjectOf(event.payload),
    occurredAt: event.createdAt.toISOString(),
  };
}
