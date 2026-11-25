import type { WebhookEventType } from './webhooks.js';

/**
 * What changed, so a console screen knows what to refetch. Only ids: the stream never carries the
 * data itself, which is read through the REST routes and their access checks.
 */
export type OrganizationEventSubject =
  | { kind: 'voucher'; id: string; batchId: string | null }
  | { kind: 'voucherOwnership'; id: string; voucherId: string; memberId: string }
  | { kind: 'loyaltyTransaction'; id: string; memberId: string }
  | { kind: 'issuanceBudget' }
  | { kind: 'webhookEndpoint'; id: string };

/**
 * One message of the console event stream (`GET /v1/console/organizations/:id/events`, OCT-326):
 * the SSE `event` is `type`, the SSE `id` is `sequence`, and `data` is this object as JSON.
 */
export interface OrganizationStreamEvent {
  /** The event's id, the same one its webhook carries. */
  id: string;
  /** Orders the organization's events; sent as the SSE `id`, so a reconnect resumes after it. */
  sequence: number;
  type: WebhookEventType;
  subject: OrganizationEventSubject;
  occurredAt: string;
}

/**
 * Stream messages about the stream itself, sent as the SSE `event` with no `id`:
 * - `stream.reset`: events since the `Last-Event-ID` are no longer available (kept 30 days) or the
 *   id is unknown. Refetch every screen, then carry on: newer events follow on the same stream.
 * - `stream.token_expired`: the Google ID token the stream was opened with expired, and the stream
 *   closes. Reconnect with a fresh token and the last `id` seen; nothing is lost.
 * - `stream.access_revoked`: the caller is no longer an active Owner or Business Developer of an
 *   active organization, and the stream closes. Don't reconnect.
 */
export const ORGANIZATION_STREAM_CONTROL = {
  reset: 'stream.reset',
  tokenExpired: 'stream.token_expired',
  accessRevoked: 'stream.access_revoked',
} as const;

export type OrganizationStreamControl = (typeof ORGANIZATION_STREAM_CONTROL)[keyof typeof ORGANIZATION_STREAM_CONTROL];
