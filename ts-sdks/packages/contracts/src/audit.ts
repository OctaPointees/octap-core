/**
 * The organization's audit log (OCT-333): who did what, and when. Durable and append-only, written
 * in the transaction of each change. `GET /v1/console/organizations/{organizationId}/audit-log`,
 * Owner only.
 */

/** A console user, an API key, or OctaP itself (a worker, the chain indexer). */
export type AuditActorType = 'USER' | 'CREDENTIAL' | 'SYSTEM';

export interface AuditActorRef {
  type: AuditActorType;
  /** A user id or an API key id; null for SYSTEM. */
  id: string | null;
  /** The user's name, or the key's name and prefix, as they are now. Null for SYSTEM or a removed record. */
  label: string | null;
}

export interface AuditLogEntry {
  id: string;
  occurredAt: string;
  actor: AuditActorRef;
  /** `<target>.<verb>` (e.g. `api_key.revoked`, `member.blocked`) or an event type (`credits.earned`). */
  action: string;
  target: { type: string; id: string | null };
  /** The request's `X-Request-Id`, to match the request log and OctaP's own logs. */
  requestId: string | null;
  /** Field names and non-personal values only, e.g. `{ status: { from: 'ACTIVE', to: 'BLOCKED' } }`. */
  changes: Record<string, unknown> | null;
}

/**
 * Newest first. `limit` 1–100 (default 50), `cursor` from the last page's `nextCursor`. `action`
 * matches exactly, or every action under a prefix when it ends with `.` (`api_key.`). Times are
 * ISO 8601.
 */
export interface AuditLogQuery {
  limit?: number;
  cursor?: string;
  from?: string;
  to?: string;
  actorType?: AuditActorType;
  actorId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
}

export interface AuditLogPage {
  items: AuditLogEntry[];
  nextCursor: string | null;
}
