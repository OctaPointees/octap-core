import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, getTableColumns } from 'drizzle-orm';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import { apiCredentials, organizations } from '../schema/organizations.schema.js';

export type ApiCredential = typeof apiCredentials.$inferSelect;

/** Every method that writes takes an optional `tx`, so a caller can join it to its own access check. */
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

  /** Locks the credential row: a concurrent revoke or rename waits instead of overwriting. */
  async findForUpdate(tx: DrizzleDb, id: string): Promise<ApiCredential | undefined> {
    const [row] = await tx.select().from(apiCredentials).where(eq(apiCredentials.id, id)).for('update');
    return row;
  }

  /**
   * Inserts the credential unless the organization already has `limit` ACTIVE ones, and returns
   * `undefined` in that case. The organization row is locked first, so two concurrent issues for the
   * same organization count one after the other and can never both take the last slot.
   */
  async createWithinLimit(
    data: { organizationId: string; name: string; keyPrefix: string; keyHash: string; scopes: string[] },
    limit: number,
    tx?: DrizzleDb,
  ): Promise<ApiCredential | undefined> {
    const work = async (db: DrizzleDb) => {
      await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, data.organizationId))
        .for('update');
      const [{ active }] = await db
        .select({ active: count() })
        .from(apiCredentials)
        .where(and(eq(apiCredentials.organizationId, data.organizationId), eq(apiCredentials.status, 'ACTIVE')));
      if (active >= limit) return undefined;
      const [created] = await db.insert(apiCredentials).values(data).returning();
      return created;
    };
    return tx ? work(tx) : this.db.transaction(work);
  }

  async touchLastUsed(id: string) {
    await this.db.update(apiCredentials).set({ lastUsedAt: new Date() }).where(eq(apiCredentials.id, id));
  }

  async revoke(tx: DrizzleDb, id: string): Promise<ApiCredential> {
    const [updated] = await tx
      .update(apiCredentials)
      .set({ status: 'REVOKED', updatedAt: new Date() })
      .where(eq(apiCredentials.id, id))
      .returning();
    return updated;
  }

  async rename(tx: DrizzleDb, id: string, name: string): Promise<ApiCredential> {
    const [updated] = await tx
      .update(apiCredentials)
      .set({ name, updatedAt: new Date() })
      .where(eq(apiCredentials.id, id))
      .returning();
    return updated;
  }

  /** Runs `work` in the caller's transaction, or in a new one. */
  async inTransaction<T>(tx: DrizzleDb | undefined, work: (tx: DrizzleDb) => Promise<T>): Promise<T> {
    return tx ? work(tx) : this.db.transaction(work);
  }
}
