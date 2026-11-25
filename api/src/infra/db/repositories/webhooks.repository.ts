import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, lte, sql } from 'drizzle-orm';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import { webhookEndpoints, webhookDeliveries } from '../schema/webhooks.schema.js';
import { withTenant } from '../rls.js';
import { inTenantOf, tenantOf } from './tenant-lookup.js';

/**
 * How long a claimed delivery stays invisible to other pollers. Comfortably above the delivery
 * HTTP timeout, so it only lapses if the claiming worker died mid-attempt — then it's retried.
 */
export const DELIVERY_CLAIM_LEASE_MS = 60_000;

/** A delivery with the event it carries, the shape every delivery read returns. */
export interface WebhookDeliveryWithEvent {
  /** This delivery, to replay it. */
  id: string;
  organizationId: string;
  endpointId: string;
  /** The event delivered: the body's `id` and `x-octap-event-id`, the same for every endpoint. */
  eventId: string;
  eventType: string;
  payload: unknown;
  status: 'PENDING' | 'DELIVERED' | 'DEAD_LETTER';
  attemptCount: number;
  nextAttemptAt: Date;
  lastResponseStatus: number | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** What the deliveries' reads join: the event's type and payload. */
const WITH_EVENT = { event: { columns: { type: true, payload: true } } } as const;

function flatten(
  row: typeof webhookDeliveries.$inferSelect & { event: { type: string; payload: unknown } },
): WebhookDeliveryWithEvent {
  const { event, ...delivery } = row;
  return { ...delivery, eventType: event.type, payload: event.payload };
}

/** Reads delivery `id` with its event, under the caller's tenant context. */
async function deliveryWithEvent(tx: DrizzleDb, id: string): Promise<WebhookDeliveryWithEvent | undefined> {
  const row = await tx.query.webhookDeliveries.findFirst({ where: eq(webhookDeliveries.id, id), with: WITH_EVENT });
  return row && flatten(row);
}

/**
 * Request-path methods take an optional `db`, so a console route can run them inside its Owner
 * check's transaction (`ConsoleWebhooksService`).
 *
 * Every method runs under an organization's RLS context (`withTenant`), except the worker's scan for
 * due deliveries across organizations (`claimDueDeliveries`). Request paths pass the authenticated
 * organization, so RLS refuses another organization's endpoint or delivery. Only the delivery
 * worker's callbacks (`findEndpointById`, `markDelivered`, `scheduleRetry`, `markDeadLetter`) start
 * from an id and run under that row's own organization.
 */
@Injectable()
export class WebhooksRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  /** Runs `work` under the organization that owns endpoint `id`. */
  private ofEndpoint<T>(id: string, work: (tx: DrizzleDb) => Promise<T>) {
    return inTenantOf(this.db, (db) => tenantOf.webhookEndpoint(db, id), work);
  }

  /** Runs `work` under the organization that owns delivery `id`. */
  private ofDelivery<T>(id: string, work: (tx: DrizzleDb) => Promise<T>) {
    return inTenantOf(this.db, (db) => tenantOf.webhookDelivery(db, id), work);
  }

  // --- Endpoints -----------------------------------------------------------

  async createEndpoint(
    params: { organizationId: string; url: string; secret: string; description?: string },
    db: DrizzleDb = this.db,
  ) {
    return withTenant(db, params.organizationId, async (tx) => {
      const [created] = await tx.insert(webhookEndpoints).values(params).returning();
      return created;
    });
  }

  async listEndpoints(organizationId: string, db: DrizzleDb = this.db) {
    return withTenant(db, organizationId, (tx) =>
      tx.query.webhookEndpoints.findMany({
        where: eq(webhookEndpoints.organizationId, organizationId),
        orderBy: [desc(webhookEndpoints.createdAt)],
      }),
    );
  }

  async findEndpointForOrganization(organizationId: string, endpointId: string, db: DrizzleDb = this.db) {
    return withTenant(db, organizationId, (tx) =>
      tx.query.webhookEndpoints.findFirst({
        where: and(eq(webhookEndpoints.id, endpointId), eq(webhookEndpoints.organizationId, organizationId)),
      }),
    );
  }

  async findEndpointById(endpointId: string) {
    return this.ofEndpoint(endpointId, (tx) =>
      tx.query.webhookEndpoints.findFirst({ where: eq(webhookEndpoints.id, endpointId) }),
    );
  }

  async setEndpointStatus(
    organizationId: string,
    endpointId: string,
    status: 'ACTIVE' | 'DISABLED',
    db: DrizzleDb = this.db,
  ) {
    return withTenant(db, organizationId, async (tx) => {
      const [updated] = await tx
        .update(webhookEndpoints)
        .set({ status, updatedAt: new Date() })
        .where(eq(webhookEndpoints.id, endpointId))
        .returning();
      return updated;
    });
  }

  async rotateEndpointSecret(organizationId: string, endpointId: string, secret: string, db: DrizzleDb = this.db) {
    return withTenant(db, organizationId, async (tx) => {
      const [updated] = await tx
        .update(webhookEndpoints)
        .set({ secret, updatedAt: new Date() })
        .where(eq(webhookEndpoints.id, endpointId))
        .returning();
      return updated;
    });
  }

  // --- Deliveries ------------------------------------------------------------

  async listDeliveries(organizationId: string, limit = 50, db: DrizzleDb = this.db) {
    return withTenant(db, organizationId, (tx) =>
      tx.query.webhookDeliveries
        .findMany({
          where: eq(webhookDeliveries.organizationId, organizationId),
          orderBy: [desc(webhookDeliveries.createdAt)],
          limit,
          with: WITH_EVENT,
        })
        .then((rows) => rows.map(flatten)),
    );
  }

  async findDeliveryForOrganization(organizationId: string, deliveryId: string, db: DrizzleDb = this.db) {
    return withTenant(db, organizationId, (tx) =>
      tx.query.webhookDeliveries
        .findFirst({
          where: and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.organizationId, organizationId)),
          with: WITH_EVENT,
        })
        .then((row) => row && flatten(row)),
    );
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
   *
   * RLS exception, for the scan only: the worker looks for due deliveries of every organization at
   * once. Each claim then runs under the delivery's own organization.
   */
  async claimDueDeliveries(limit = 10) {
    const candidates = await this.db.query.webhookDeliveries.findMany({
      where: and(eq(webhookDeliveries.status, 'PENDING'), lte(webhookDeliveries.nextAttemptAt, sql`now()`)),
      orderBy: [asc(webhookDeliveries.nextAttemptAt)],
      limit,
    });

    const claimed: WebhookDeliveryWithEvent[] = [];
    for (const candidate of candidates) {
      const row = await withTenant(this.db, candidate.organizationId, async (tx) => {
        const [won] = await tx
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
          .returning({ id: webhookDeliveries.id });
        return won && deliveryWithEvent(tx, won.id);
      });
      if (row) {
        claimed.push(row);
      }
    }
    return claimed;
  }

  async markDelivered(id: string, responseStatus: number) {
    await this.ofDelivery(id, (tx) =>
      tx
        .update(webhookDeliveries)
        .set({ status: 'DELIVERED', lastResponseStatus: responseStatus, lastError: null, updatedAt: new Date() })
        .where(eq(webhookDeliveries.id, id)),
    );
  }

  async scheduleRetry(id: string, nextAttemptAt: Date, responseStatus: number | null, error: string) {
    await this.ofDelivery(id, (tx) =>
      tx
        .update(webhookDeliveries)
        .set({
          status: 'PENDING',
          nextAttemptAt,
          lastResponseStatus: responseStatus,
          lastError: error,
          updatedAt: new Date(),
        })
        .where(eq(webhookDeliveries.id, id)),
    );
  }

  async markDeadLetter(id: string, responseStatus: number | null, error: string) {
    await this.ofDelivery(id, (tx) =>
      tx
        .update(webhookDeliveries)
        .set({ status: 'DEAD_LETTER', lastResponseStatus: responseStatus, lastError: error, updatedAt: new Date() })
        .where(eq(webhookDeliveries.id, id)),
    );
  }

  /** Resets a FAILED/DEAD_LETTER delivery back to PENDING for immediate redelivery, same id. */
  async resetForReplay(organizationId: string, id: string, db: DrizzleDb = this.db) {
    return withTenant(db, organizationId, async (tx) => {
      const [updated] = await tx
        .update(webhookDeliveries)
        .set({
          status: 'PENDING',
          attemptCount: 0,
          nextAttemptAt: new Date(),
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(webhookDeliveries.id, id))
        .returning({ id: webhookDeliveries.id });
      return updated && deliveryWithEvent(tx, updated.id);
    });
  }
}
