import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import { programs } from '../schema/programs.schema.js';
import { enqueueWebhookEvent } from './webhooks.repository.js';

@Injectable()
export class ProgramsRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  async findByOrganization(organizationId: string) {
    return this.db.query.programs.findFirst({ where: eq(programs.organizationId, organizationId) });
  }

  listActive() {
    return this.db.query.programs.findMany({ where: eq(programs.status, 'ACTIVE') });
  }

  /**
   * Moves the reported threshold from `previous` to `next`, sending `budget.low` when it rises. The
   * conditional update makes one crossing send one event, however many workers check it.
   */
  async recordBudgetWarning(params: {
    programId: string;
    organizationId: string;
    previous: number;
    next: number;
    remaining: number;
    capacity: number;
  }) {
    await this.db.transaction(async (tx) => {
      const updated = await tx
        .update(programs)
        .set({ budgetWarningThreshold: params.next })
        .where(and(eq(programs.id, params.programId), eq(programs.budgetWarningThreshold, params.previous)))
        .returning({ id: programs.id });
      if (updated.length === 0 || params.next <= params.previous) return;
      await enqueueWebhookEvent(tx, {
        organizationId: params.organizationId,
        eventType: 'budget.low',
        payload: { threshold: params.next, remaining: params.remaining, capacity: params.capacity },
      });
    });
  }

  /**
   * Claims `organizationId` as a `PROVISIONING` row before any chain call. Throws a unique
   * violation on `programs_organization_id_idx` if the organization already has a row.
   */
  async reserve(params: {
    organizationId: string;
    policyVersion: number;
    earnBps: number;
    expiryMs: number;
    shardCount: number;
    totalBudget: number;
  }) {
    const [reserved] = await this.db.insert(programs).values(params).returning();
    return reserved;
  }

  async activate(
    id: string,
    chainIds: {
      programControlId: string;
      adminCapId: string;
      policyVersionId: string;
      issuerCapId: string;
      operationShardIds: string[];
      budgetShardIds: string[];
    },
  ) {
    const [activated] = await this.db
      .update(programs)
      .set({ ...chainIds, status: 'ACTIVE' })
      .where(eq(programs.id, id))
      .returning();
    return activated;
  }

  async release(id: string) {
    await this.db.delete(programs).where(eq(programs.id, id));
  }
}
