import { Inject, Injectable } from '@nestjs/common';
import { eq, desc, getTableColumns } from 'drizzle-orm';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import { apiCredentials, organizations } from '../schema/organizations.schema.js';

@Injectable()
export class ApiCredentialsRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  async findByKeyHash(keyHash: string) {
    const [row] = await this.db
      .select({ ...getTableColumns(apiCredentials), organizationStatus: organizations.status })
      .from(apiCredentials)
      .innerJoin(organizations, eq(organizations.id, apiCredentials.organizationId))
      .where(eq(apiCredentials.keyHash, keyHash));
    return row;
  }

  async findById(id: string) {
    return this.db.query.apiCredentials.findFirst({
      where: eq(apiCredentials.id, id),
    });
  }

  async listByOrganization(organizationId: string) {
    return this.db.query.apiCredentials.findMany({
      where: eq(apiCredentials.organizationId, organizationId),
      orderBy: [desc(apiCredentials.createdAt)],
    });
  }

  async create(data: {
    organizationId: string;
    name: string;
    keyPrefix: string;
    keyHash: string;
    scopes: string[];
    expiresAt?: Date;
  }) {
    const [created] = await this.db
      .insert(apiCredentials)
      .values({
        organizationId: data.organizationId,
        name: data.name,
        keyPrefix: data.keyPrefix,
        keyHash: data.keyHash,
        scopes: data.scopes,
        expiresAt: data.expiresAt,
      })
      .returning();

    return created;
  }

  async touchLastUsed(id: string) {
    await this.db.update(apiCredentials).set({ lastUsedAt: new Date() }).where(eq(apiCredentials.id, id));
  }

  async revoke(id: string) {
    const [updated] = await this.db
      .update(apiCredentials)
      .set({ status: 'REVOKED', updatedAt: new Date() })
      .where(eq(apiCredentials.id, id))
      .returning();

    return updated;
  }
}
