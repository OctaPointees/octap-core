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

  async create(params: {
    organizationId: string;
    programControlId: string;
    adminCapId: string;
    policyVersionId: string;
    issuerCapId: string;
    policyVersion: number;
    earnBps: number;
    expiryMs: number;
  }) {
    const [created] = await this.db.insert(programs).values(params).returning();
    return created;
  }
}
