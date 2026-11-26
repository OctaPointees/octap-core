import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, lt, max, notExists } from 'drizzle-orm';
import type { WebhookEventData, WebhookEventType } from '@octap/contracts';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import { organizationEvents } from '../schema/events.schema.js';
import { webhookDeliveries, webhookEndpoints } from '../schema/webhooks.schema.js';
import { withTenant } from '../rls.js';
import { auditTargetOfEvent, recordAudit } from './audit.repository.js';
import { hasRequestActor } from '#observability/request-context.js';

export type OrganizationEvent = typeof organizationEvents.$inferSelect;

/**
 * The outbox (OCT-325): records that `type` happened to the organization, on the caller's `tx`, so the
 * event commits or rolls back with the change it describes. It is recorded whether or not the
 * organization has a webhook endpoint (the console stream and an audit log read it too), and queued
 * for delivery to each ACTIVE endpoint in the same transaction. A function, not a repository method,
 * for the same reason as `acceptCommand`: it must never open its own transaction. Call it under the
 * organization's tenant context (`withTenant`), as every caller already is.
 */
export async function recordEvent<T extends WebhookEventType>(
  tx: DrizzleDb,
  params: { organizationId: string; type: T; payload: WebhookEventData<T> },
): Promise<OrganizationEvent> {
  const [event] = await tx
    .insert(organizationEvents)
    .values({ organizationId: params.organizationId, type: params.type, payload: params.payload })
    .returning();
  const endpoints = await tx
    .select({ id: webhookEndpoints.id })
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.organizationId, params.organizationId), eq(webhookEndpoints.status, 'ACTIVE')));
  if (endpoints.length > 0) {
    await tx.insert(webhookDeliveries).values(
      endpoints.map((endpoint) => ({
        organizationId: params.organizationId,
        endpointId: endpoint.id,
        eventId: event.id,
      })),
    );
  }
  // A change someone made (an API key or a console user, not a worker or the chain) is also
  // audited, durably, in the same transaction (OCT-333). The event itself is trimmed after 30 days.
  if (hasRequestActor()) {
    const target = auditTargetOfEvent(params.type, params.payload as unknown as Record<string, unknown>);
    await recordAudit(tx, {
      organizationId: params.organizationId,
      action: params.type,
      targetType: target.type,
      targetId: target.id,
      changes: { eventId: event.id },
    });
  }
  return event;
}

/**
 * A `webhook.test` event (OCT-297's test ping), queued for `endpointId` only. Like `recordEvent` it
 * goes through the outbox, so it is signed, retried and listed like any delivery; unlike it, it
 * does not fan out to the organization's other endpoints. Call it under the organization's tenant
 * context.
 */
export async function recordTestEvent(
  tx: DrizzleDb,
  params: { organizationId: string; endpointId: string },
): Promise<{ eventId: string; deliveryId: string }> {
  const data: WebhookEventData<'webhook.test'> = {
    endpointId: params.endpointId,
    message: 'Test event from the OctaP console. Nothing happened in your organization.',
  };
  const [event] = await tx
    .insert(organizationEvents)
    .values({ organizationId: params.organizationId, type: 'webhook.test', payload: data })
    .returning();
  const [delivery] = await tx
    .insert(webhookDeliveries)
    .values({ organizationId: params.organizationId, endpointId: params.endpointId, eventId: event.id })
    .returning({ id: webhookDeliveries.id });
  // Its own writer, not `recordEvent`, so the automatic event audit does not cover it (OCT-333).
  await recordAudit(tx, {
    organizationId: params.organizationId,
    action: 'webhook_endpoint.tested',
    targetType: 'webhook_endpoint',
    targetId: params.endpointId,
    changes: { eventId: event.id, deliveryId: delivery.id },
  });
  return { eventId: event.id, deliveryId: delivery.id };
}

/**
 * Reads the outbox for the console event stream (OCT-326) and trims it. `replaySince` and `hasEvent`
 * run under the organization's RLS context. Two methods are RLS exceptions, by design: the stream's
 * scan (`latestSequence`, `scanSince`) reads every organization that has a stream open on this
 * instance, and `deleteExpired` trims every organization's old events.
 */
@Injectable()
export class OrganizationEventsRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  /** The highest sequence recorded so far, 0 when there is none. RLS exception (environment-wide). */
  async latestSequence(): Promise<number> {
    const [row] = await this.db.select({ latest: max(organizationEvents.sequence) }).from(organizationEvents);
    return Number(row?.latest ?? 0);
  }

  /**
   * Events of `organizationIds` after `afterSequence`, oldest first. RLS exception: one query for
   * every organization with a stream open on this instance, each event then goes only to its own.
   */
  async scanSince(organizationIds: string[], afterSequence: number, limit: number): Promise<OrganizationEvent[]> {
    if (organizationIds.length === 0) return [];
    return this.db
      .select()
      .from(organizationEvents)
      .where(
        and(
          inArray(organizationEvents.organizationId, organizationIds),
          gt(organizationEvents.sequence, afterSequence),
        ),
      )
      .orderBy(asc(organizationEvents.sequence))
      .limit(limit);
  }

  /** The organization's events after `afterSequence`, oldest first, at most `limit`. */
  async replaySince(organizationId: string, afterSequence: number, limit: number): Promise<OrganizationEvent[]> {
    return withTenant(this.db, organizationId, (tx) =>
      tx
        .select()
        .from(organizationEvents)
        .where(
          and(eq(organizationEvents.organizationId, organizationId), gt(organizationEvents.sequence, afterSequence)),
        )
        .orderBy(asc(organizationEvents.sequence))
        .limit(limit),
    );
  }

  /** Whether the organization still has the event numbered `sequence`: another's is not found. */
  async hasEvent(organizationId: string, sequence: number): Promise<boolean> {
    const [row] = await withTenant(this.db, organizationId, (tx) =>
      tx
        .select({ id: organizationEvents.id })
        .from(organizationEvents)
        .where(and(eq(organizationEvents.organizationId, organizationId), eq(organizationEvents.sequence, sequence))),
    );
    return row !== undefined;
  }

  /**
   * Deletes up to `limit` events recorded before `before`, oldest first, and returns how many. One
   * still owed to an endpoint (a PENDING delivery) or that the Owner may still replay (DEAD_LETTER) is
   * kept: deleting an event deletes its deliveries. RLS exception (every organization).
   */
  async deleteExpired(before: Date, limit: number): Promise<number> {
    const owed = this.db
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.eventId, organizationEvents.id),
          inArray(webhookDeliveries.status, ['PENDING', 'DEAD_LETTER']),
        ),
      );
    const expired = this.db
      .select({ id: organizationEvents.id })
      .from(organizationEvents)
      .where(and(lt(organizationEvents.createdAt, before), notExists(owed)))
      .orderBy(asc(organizationEvents.sequence))
      .limit(limit);
    const deleted = await this.db
      .delete(organizationEvents)
      .where(inArray(organizationEvents.id, expired))
      .returning({ id: organizationEvents.id });
    return deleted.length;
  }
}
