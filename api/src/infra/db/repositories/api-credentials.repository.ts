import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, getTableColumns } from 'drizzle-orm';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import { apiCredentials, organizations } from '../schema/organizations.schema.js';
import { withTenant } from '../rls.js';
import { requireLicenseCapacity } from './license-enforcement.js';
import { recordAudit } from './audit.repository.js';

export type ApiCredential = typeof apiCredentials.$inferSelect;

/**
 * Every method that writes takes an optional `tx`, so a caller can join it to its own access check.
 * Everything but `findByKeyHash` runs under the organization's RLS context (`withTenant`), so
 * Postgres itself hides other organizations' keys.
 */
@Injectable()
export class ApiCredentialsRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  /**
   * RLS exception: the guard calls this to learn which organization a key belongs to, so there is no
   * organization to scope it to yet. It matches on the key's hash only.
   */
  async findByKeyHash(keyHash: string) {
    const [row] = await this.db
      .select({ ...getTableColumns(apiCredentials), organizationStatus: organizations.status })
      .from(apiCredentials)
      .innerJoin(organizations, eq(organizations.id, apiCredentials.organizationId))
      .where(eq(apiCredentials.keyHash, keyHash));
    return row;
  }

  /** Locks the credential row: a concurrent revoke or rename waits instead of overwriting. */
  async findForUpdate(tx: DrizzleDb, organizationId: string, id: string): Promise<ApiCredential | undefined> {
    return withTenant(tx, organizationId, async (db) => {
      const [row] = await db.select().from(apiCredentials).where(eq(apiCredentials.id, id)).for('update');
      return row;
    });
  }

  /**
   * Inserts the credential unless the organization already has `limit` ACTIVE ones, and returns
   * `undefined` in that case. The organization row is locked first, so two concurrent issues for the
   * same organization count one after the other and can never both take the last slot. That lock is
   * taken before the RLS context: the tenant role can neither see nor lock `organizations`.
   */
  async createWithinLimit(
    data: {
      organizationId: string;
      name: string;
      keyPrefix: string;
      keyHash: string;
      scopes: string[];
      environment?: 'LIVE' | 'SANDBOX';
    },
    limit: number,
    tx?: DrizzleDb,
  ): Promise<ApiCredential | undefined> {
    const work = async (db: DrizzleDb) => {
      await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, data.organizationId))
        .for('update');
      return withTenant(db, data.organizationId, async (scoped) => {
        const [{ active }] = await scoped
          .select({ active: count() })
          .from(apiCredentials)
          .where(and(eq(apiCredentials.organizationId, data.organizationId), eq(apiCredentials.status, 'ACTIVE')));
        if (active >= limit) return undefined;
        // The license's own cap, usually lower than the platform's (OCT-329). 402 when reached.
        await requireLicenseCapacity(scoped, data.organizationId, 'apiKeys', async () => active);
        const [created] = await scoped.insert(apiCredentials).values(data).returning();
        await recordAudit(scoped, {
          organizationId: data.organizationId,
          action: 'api_key.issued',
          targetType: 'api_key',
          targetId: created.id,
          changes: {
            name: created.name,
            scopes: created.scopes,
            environment: created.environment,
            keyPrefix: created.keyPrefix,
          },
        });
        return created;
      });
    };
    return tx ? work(tx) : this.db.transaction(work);
  }

  async touchLastUsed(organizationId: string, id: string) {
    await withTenant(this.db, organizationId, (db) =>
      db.update(apiCredentials).set({ lastUsedAt: new Date() }).where(eq(apiCredentials.id, id)),
    );
  }

  async revoke(tx: DrizzleDb, organizationId: string, id: string): Promise<ApiCredential> {
    return withTenant(tx, organizationId, async (db) => {
      const [updated] = await db
        .update(apiCredentials)
        .set({ status: 'REVOKED', updatedAt: new Date() })
        .where(eq(apiCredentials.id, id))
        .returning();
      await recordAudit(db, { organizationId, action: 'api_key.revoked', targetType: 'api_key', targetId: id });
      return updated;
    });
  }

  async rename(tx: DrizzleDb, organizationId: string, id: string, name: string): Promise<ApiCredential> {
    return withTenant(tx, organizationId, async (db) => {
      const [before] = await db
        .select({ name: apiCredentials.name })
        .from(apiCredentials)
        .where(eq(apiCredentials.id, id));
      await recordAudit(db, {
        organizationId,
        action: 'api_key.renamed',
        targetType: 'api_key',
        targetId: id,
        changes: { name: { from: before?.name ?? null, to: name } },
      });
      const [updated] = await db
        .update(apiCredentials)
        .set({ name, updatedAt: new Date() })
        .where(eq(apiCredentials.id, id))
        .returning();
      return updated;
    });
  }

  /** Runs `work` in the caller's transaction, or in a new one. */
  async inTransaction<T>(tx: DrizzleDb | undefined, work: (tx: DrizzleDb) => Promise<T>): Promise<T> {
    return tx ? work(tx) : this.db.transaction(work);
  }
}
