import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import { programs } from '../schema/programs.schema.js';

@Injectable()
export class ProgramsRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  async findByOrganization(organizationId: string) {
    return this.db.query.programs.findFirst({ where: eq(programs.organizationId, organizationId) });
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
