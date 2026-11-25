import { and, eq } from 'drizzle-orm';
import type { WebhookEventData, WebhookEventType } from '@octap/contracts';
import type { DrizzleDb } from '../postgres.provider.js';
import { organizationEvents } from '../schema/events.schema.js';
import { webhookDeliveries, webhookEndpoints } from '../schema/webhooks.schema.js';

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
  return event;
}
