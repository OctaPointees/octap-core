import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, lte, sql } from 'drizzle-orm';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import { webhookEndpoints, webhookDeliveries } from '../schema/webhooks.schema.js';

/**
 * How long a claimed delivery stays invisible to other pollers. Comfortably above the delivery
 * HTTP timeout, so it only lapses if the claiming worker died mid-attempt — then it's retried.
 */
export const DELIVERY_CLAIM_LEASE_MS = 60_000;

/**
 * Outbox form of `WebhookDeliveryService.emit()`: queues `eventType` for every ACTIVE endpoint of
 * the organization on the caller's `tx`, so the deliveries commit or roll back with the write that
 * caused them. A function, not a repository method, for the same reason as `acceptCommand`: it
 * must never open its own transaction. Returns how many deliveries were queued.
 */
export async function enqueueWebhookEvent(
  tx: DrizzleDb,
  params: { organizationId: string; eventType: string; payload: Record<string, unknown> },
): Promise<number> {
  const endpoints = await tx
    .select({ id: webhookEndpoints.id })
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.organizationId, params.organizationId), eq(webhookEndpoints.status, 'ACTIVE')));
  if (endpoints.length === 0) {
    return 0;
  }
  await tx.insert(webhookDeliveries).values(
    endpoints.map((endpoint) => ({
      organizationId: params.organizationId,
      endpointId: endpoint.id,
      eventType: params.eventType,
      payload: params.payload,
    })),
  );
  return endpoints.length;
}

@Injectable()
export class WebhooksRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  // --- Endpoints -----------------------------------------------------------

  async createEndpoint(params: { organizationId: string; url: string; secret: string; description?: string }) {
    const [created] = await this.db.insert(webhookEndpoints).values(params).returning();
    return created;
  }

  async listEndpoints(organizationId: string) {
    return this.db.query.webhookEndpoints.findMany({
      where: eq(webhookEndpoints.organizationId, organizationId),
      orderBy: [desc(webhookEndpoints.createdAt)],
    });
  }

  async findEndpointForOrganization(organizationId: string, endpointId: string) {
    return this.db.query.webhookEndpoints.findFirst({
      where: and(eq(webhookEndpoints.id, endpointId), eq(webhookEndpoints.organizationId, organizationId)),
    });
  }

  async findEndpointById(endpointId: string) {
    return this.db.query.webhookEndpoints.findFirst({ where: eq(webhookEndpoints.id, endpointId) });
  }

  async listActiveEndpoints(organizationId: string) {
    return this.db.query.webhookEndpoints.findMany({
      where: and(eq(webhookEndpoints.organizationId, organizationId), eq(webhookEndpoints.status, 'ACTIVE')),
    });
  }

  async setEndpointStatus(endpointId: string, status: 'ACTIVE' | 'DISABLED') {
    const [updated] = await this.db
      .update(webhookEndpoints)
      .set({ status, updatedAt: new Date() })
      .where(eq(webhookEndpoints.id, endpointId))
      .returning();
    return updated;
  }

  async rotateEndpointSecret(endpointId: string, secret: string) {
    const [updated] = await this.db
      .update(webhookEndpoints)
      .set({ secret, updatedAt: new Date() })
      .where(eq(webhookEndpoints.id, endpointId))
      .returning();
    return updated;
  }

  // --- Deliveries ------------------------------------------------------------

  async enqueueDelivery(params: {
    organizationId: string;
    endpointId: string;
    eventType: string;
    payload: Record<string, unknown>;
  }) {
    const [created] = await this.db.insert(webhookDeliveries).values(params).returning();
    return created;
  }

  async listDeliveries(organizationId: string, limit = 50) {
    return this.db.query.webhookDeliveries.findMany({
      where: eq(webhookDeliveries.organizationId, organizationId),
      orderBy: [desc(webhookDeliveries.createdAt)],
      limit,
    });
  }

  async findDeliveryForOrganization(organizationId: string, deliveryId: string) {
    return this.db.query.webhookDeliveries.findFirst({
      where: and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.organizationId, organizationId)),
    });
  }

  /**
   * Claims up to `limit` PENDING deliveries whose `nextAttemptAt` is due, bumping
   * `attemptCount` with a conditional update so two worker instances racing on the same
   * row only ever have one succeed (same pattern as `OperationsRepository.claimNextPending`
   * on the chain-submit path). A claim leaves the row PENDING, so the condition is on the
   * `attemptCount` that was read, not just the status — otherwise both racers' updates match —
   * and it pushes `nextAttemptAt` out by `DELIVERY_CLAIM_LEASE_MS` so a poll that starts after
   * the claim committed doesn't see the row as due again. The processor's own outcome
   * (`markDelivered`/`scheduleRetry`/`markDeadLetter`) replaces the lease.
   *
   * "Due" is judged on the database clock (`now()`), the same clock that stamped
   * `nextAttemptAt` on enqueue: a JS `Date` is truncated to the millisecond, so a delivery
   * enqueued earlier in that same millisecond would compare as not yet due and be skipped.
   */
  async claimDueDeliveries(limit = 10) {
    const candidates = await this.db.query.webhookDeliveries.findMany({
      where: and(eq(webhookDeliveries.status, 'PENDING'), lte(webhookDeliveries.nextAttemptAt, sql`now()`)),
      orderBy: [asc(webhookDeliveries.nextAttemptAt)],
      limit,
    });

    const claimed: (typeof webhookDeliveries.$inferSelect)[] = [];
    for (const candidate of candidates) {
      const [row] = await this.db
        .update(webhookDeliveries)
        .set({
          attemptCount: candidate.attemptCount + 1,
          nextAttemptAt: new Date(Date.now() + DELIVERY_CLAIM_LEASE_MS),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(webhookDeliveries.id, candidate.id),
            eq(webhookDeliveries.status, 'PENDING'),
            eq(webhookDeliveries.attemptCount, candidate.attemptCount),
          ),
        )
        .returning();
      if (row) {
        claimed.push(row);
      }
    }
    return claimed;
  }

  async markDelivered(id: string, responseStatus: number) {
    await this.db
      .update(webhookDeliveries)
      .set({ status: 'DELIVERED', lastResponseStatus: responseStatus, lastError: null, updatedAt: new Date() })
      .where(eq(webhookDeliveries.id, id));
  }

  async scheduleRetry(id: string, nextAttemptAt: Date, responseStatus: number | null, error: string) {
    await this.db
      .update(webhookDeliveries)
      .set({
        status: 'PENDING',
        nextAttemptAt,
        lastResponseStatus: responseStatus,
        lastError: error,
        updatedAt: new Date(),
      })
      .where(eq(webhookDeliveries.id, id));
  }

  async markDeadLetter(id: string, responseStatus: number | null, error: string) {
    await this.db
      .update(webhookDeliveries)
      .set({ status: 'DEAD_LETTER', lastResponseStatus: responseStatus, lastError: error, updatedAt: new Date() })
      .where(eq(webhookDeliveries.id, id));
  }

  /** Resets a FAILED/DEAD_LETTER delivery back to PENDING for immediate redelivery, same id. */
  async resetForReplay(id: string) {
    const [updated] = await this.db
      .update(webhookDeliveries)
      .set({ status: 'PENDING', attemptCount: 0, nextAttemptAt: new Date(), lastError: null, updatedAt: new Date() })
      .where(eq(webhookDeliveries.id, id))
      .returning();
    return updated;
  }
}
