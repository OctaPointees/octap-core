import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, lte } from 'drizzle-orm';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import { webhookEndpoints, webhookDeliveries } from '../schema/webhooks.schema.js';

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
   * on the chain-submit path).
   */
  async claimDueDeliveries(limit = 10) {
    const candidates = await this.db.query.webhookDeliveries.findMany({
      where: and(eq(webhookDeliveries.status, 'PENDING'), lte(webhookDeliveries.nextAttemptAt, new Date())),
      orderBy: [asc(webhookDeliveries.nextAttemptAt)],
      limit,
    });

    const claimed: (typeof webhookDeliveries.$inferSelect)[] = [];
    for (const candidate of candidates) {
      const [row] = await this.db
        .update(webhookDeliveries)
        .set({ attemptCount: candidate.attemptCount + 1, updatedAt: new Date() })
        .where(and(eq(webhookDeliveries.id, candidate.id), eq(webhookDeliveries.status, 'PENDING')))
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
      .set({ status: 'PENDING', nextAttemptAt, lastResponseStatus: responseStatus, lastError: error, updatedAt: new Date() })
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
