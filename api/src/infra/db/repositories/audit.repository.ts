import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, inArray, like, lt, sql, type SQL } from 'drizzle-orm';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import { auditLog } from '../schema/audit.schema.js';
import { apiCredentials } from '../schema/organizations.schema.js';
import { systemUsers } from '../schema/auth.schema.js';
import { asOwnRole, withTenant } from '../rls.js';
import { currentActor, currentRequestId, type AuditActor } from '#observability/request-context.js';

export type AuditEntry = typeof auditLog.$inferSelect;

export interface AuditRecord {
  organizationId: string;
  action: string;
  targetType: string;
  targetId?: string | null;
  changes?: Record<string, unknown> | null;
  /** Defaults to the current request's caller (`currentActor()`), `SYSTEM` outside a request. */
  actor?: AuditActor;
}

/**
 * Records one audit row on the caller's `tx`, so it commits or rolls back with the change it
 * describes (OCT-333). A function, not a repository method, for the same reason as `recordEvent`:
 * it must never open its own transaction. The actor and request id come from the request context
 * unless given. Call it under the organization's tenant context, or as the connection's own role.
 */
export async function recordAudit(tx: DrizzleDb, record: AuditRecord): Promise<void> {
  const actor = record.actor ?? currentActor();
  await tx.insert(auditLog).values({
    organizationId: record.organizationId,
    actorType: actor.type,
    actorId: actor.id,
    action: record.action,
    targetType: record.targetType,
    targetId: record.targetId ?? null,
    requestId: currentRequestId() ?? null,
    changes: record.changes ?? null,
  });
}

/**
 * What an outbox event is about, as an audit target: the record the change was made to. Every
 * event payload carries the id of that record.
 */
export function auditTargetOfEvent(
  type: string,
  payload: Record<string, unknown>,
): { type: string; id: string | null } {
  const id = (key: string) => (typeof payload[key] === 'string' ? (payload[key] as string) : null);
  if (type === 'credits.reversed') return { type: 'loyalty_transaction', id: id('reversalTransactionId') };
  if (type.startsWith('credits.')) return { type: 'loyalty_transaction', id: id('transactionId') };
  if (type === 'voucher.granted' || type === 'voucher.redeemed')
    return { type: 'voucher_ownership', id: id('voucherOwnershipId') };
  if (type.startsWith('voucher.')) return { type: 'voucher', id: id('voucherId') };
  if (type.startsWith('webhook.')) return { type: 'webhook_endpoint', id: id('endpointId') };
  return { type: 'organization', id: null };
}

/** Already validated by `AuditLogService`. `action` matches a prefix when it ends with `.`. */
export interface AuditQuery {
  from?: Date;
  to?: Date;
  actorType?: AuditActor['type'];
  actorId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
}

export type AuditRow = AuditEntry & { actorLabel: string | null };

/** The audit log's reads, under the organization's RLS context. */
@Injectable()
export class AuditRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  /**
   * Newest first. `cursor` is the last row's id, so it is opaque: `sequence` is shared by every
   * organization, and two cursors compared would tell how many actions others took in between.
   * `null` for a cursor outside this organization.
   */
  async page(tx: DrizzleDb, organizationId: string, query: AuditQuery, limit: number, cursor?: string) {
    return withTenant(tx, organizationId, async (db) => {
      const where = this.filters(organizationId, query);
      if (cursor !== undefined) {
        const [anchor] = await db
          .select({ id: auditLog.id })
          .from(auditLog)
          .where(and(eq(auditLog.organizationId, organizationId), eq(auditLog.id, cursor)));
        if (!anchor) return null;
      }
      const rows = await db
        .select()
        .from(auditLog)
        .where(
          and(
            where,
            cursor !== undefined
              ? lt(auditLog.sequence, sql`(select a.sequence from ${auditLog} a where a.id = ${cursor})`)
              : undefined,
          ),
        )
        .orderBy(desc(auditLog.sequence))
        .limit(limit + 1);
      const more = rows.length > limit;
      if (more) rows.pop();
      return { rows: await this.labelled(db, organizationId, rows), nextCursor: more ? rows.at(-1)!.id : null };
    });
  }

  /**
   * Resolves a display label for each actor at read time: a user's name or email, a key's name and
   * prefix. Only ids are stored, so the label reflects the source row as it is now.
   */
  private async labelled(db: DrizzleDb, organizationId: string, rows: AuditEntry[]): Promise<AuditRow[]> {
    const ids = (type: AuditActor['type']) => [
      ...new Set(rows.filter((row) => row.actorType === type && row.actorId).map((row) => row.actorId!)),
    ];
    const userIds = ids('USER');
    const keyIds = ids('CREDENTIAL');
    // `system_users` has no tenant policy: read it as the connection's own role, ids from this page
    // only, on the caller's transaction. A second pool connection here would let concurrent reads
    // hold every connection while each waits for another.
    const users = userIds.length
      ? await asOwnRole(db, (own) =>
          own
            .select({ id: systemUsers.id, fullName: systemUsers.fullName, email: systemUsers.email })
            .from(systemUsers)
            .where(inArray(systemUsers.id, userIds)),
        )
      : [];
    const keys = keyIds.length
      ? await db
          .select({ id: apiCredentials.id, name: apiCredentials.name, keyPrefix: apiCredentials.keyPrefix })
          .from(apiCredentials)
          .where(and(eq(apiCredentials.organizationId, organizationId), inArray(apiCredentials.id, keyIds)))
      : [];
    const labels = new Map<string, string>([
      ...users.map((user): [string, string] => [user.id, user.fullName || user.email]),
      ...keys.map((key): [string, string] => [key.id, `${key.name} (${key.keyPrefix}…)`]),
    ]);
    return rows.map((row) => ({ ...row, actorLabel: row.actorId ? (labels.get(row.actorId) ?? null) : null }));
  }

  private filters(organizationId: string, query: AuditQuery): SQL | undefined {
    return and(
      eq(auditLog.organizationId, organizationId),
      query.from ? gte(auditLog.occurredAt, query.from) : undefined,
      query.to ? lt(auditLog.occurredAt, query.to) : undefined,
      query.actorType ? eq(auditLog.actorType, query.actorType) : undefined,
      query.actorId ? eq(auditLog.actorId, query.actorId) : undefined,
      query.action
        ? query.action.endsWith('.')
          ? like(auditLog.action, `${query.action.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
          : eq(auditLog.action, query.action)
        : undefined,
      query.targetType ? eq(auditLog.targetType, query.targetType) : undefined,
      query.targetId ? eq(auditLog.targetId, query.targetId) : undefined,
    );
  }
}
