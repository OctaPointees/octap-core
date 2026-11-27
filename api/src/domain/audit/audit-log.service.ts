import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { AuditActorType, AuditLogEntry, AuditLogPage } from '@octap/contracts';
import { AuditRepository, type AuditQuery, type AuditRow } from '#infra/db/repositories/audit.repository.js';
import { ConsoleAccessError } from '#infra/db/repositories/console-access.js';
import { ConsoleOrganizationsRepository } from '#infra/db/repositories/console-organizations.repository.js';

const ACTOR_TYPES: AuditActorType[] = ['USER', 'CREDENTIAL', 'SYSTEM'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** ISO 8601 date-time with an explicit offset or Z, so the server's time zone never decides. */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
const KEYS = ['limit', 'cursor', 'from', 'to', 'actorType', 'actorId', 'action', 'targetType', 'targetId'];

/**
 * Reads the organization's audit log (OCT-333). Owner only: it shows what every member of the
 * team and every key did, which a Business Developer is not meant to oversee.
 */
@Injectable()
export class AuditLogService {
  constructor(
    private readonly organizations: ConsoleOrganizationsRepository,
    private readonly audit: AuditRepository,
  ) {}

  async list(userId: string, organizationId: string, input: Record<string, unknown>): Promise<AuditLogPage> {
    const unknown = Object.keys(input).filter((key) => !KEYS.includes(key));
    if (unknown.length) throw new BadRequestException(`Unsupported query fields: ${unknown.join(', ')}`);
    const limit = input.limit === undefined ? 50 : Number(input.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BadRequestException('limit must be 1–100');
    const cursor = input.cursor === undefined ? undefined : input.cursor;
    if (cursor !== undefined && (typeof cursor !== 'string' || !UUID.test(cursor)))
      throw new BadRequestException('Invalid cursor');
    const query = parseQuery(input);
    let page: Awaited<ReturnType<AuditRepository['page']>>;
    try {
      page = await this.organizations.withOwnerAccess(userId, organizationId, (tx) =>
        this.audit.page(tx, organizationId, query, limit, cursor),
      );
    } catch (error) {
      if (error instanceof ConsoleAccessError)
        throw new ForbiddenException('Only the active Owner of an active organization can read its audit log');
      throw error;
    }
    if (!page) throw new BadRequestException('Invalid cursor');
    return { items: page.rows.map(toEntry), nextCursor: page.nextCursor };
  }
}

function parseQuery(input: Record<string, unknown>): AuditQuery {
  const query: AuditQuery = {};
  for (const key of ['from', 'to'] as const) {
    if (input[key] === undefined) continue;
    const value = input[key];
    const date = typeof value === 'string' && ISO_DATE_TIME.test(value) ? new Date(value) : new Date(NaN);
    if (Number.isNaN(date.getTime()))
      throw new BadRequestException(`${key} must be an ISO 8601 date-time with an offset or Z`);
    query[key] = date;
  }
  if (query.from && query.to && query.from >= query.to) throw new BadRequestException('from must be before to');
  if (input.actorType !== undefined) {
    if (!ACTOR_TYPES.includes(input.actorType as AuditActorType))
      throw new BadRequestException(`actorType must be one of ${ACTOR_TYPES.join(', ')}`);
    query.actorType = input.actorType as AuditActorType;
  }
  if (input.actorId !== undefined) {
    if (typeof input.actorId !== 'string' || !UUID.test(input.actorId))
      throw new BadRequestException('actorId must be a UUID');
    query.actorId = input.actorId;
  }
  for (const key of ['action', 'targetType', 'targetId'] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !value || value.length > 100)
      throw new BadRequestException(`${key} must be 1–100 characters`);
    query[key] = value;
  }
  return query;
}

function toEntry(row: AuditRow): AuditLogEntry {
  return {
    id: row.id,
    occurredAt: row.occurredAt.toISOString(),
    actor: { type: row.actorType, id: row.actorId, label: row.actorLabel },
    action: row.action,
    target: { type: row.targetType, id: row.targetId },
    requestId: row.requestId,
    changes: row.changes as Record<string, unknown> | null,
  };
}
