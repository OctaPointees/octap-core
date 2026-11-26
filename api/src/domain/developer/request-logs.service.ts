import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  REQUEST_LOG_CATEGORIES,
  REQUEST_LOG_RETENTION_DAYS,
  type RequestLogCategory,
  type RequestLogDetail,
  type RequestLogEntry,
  type RequestLogErrorGroup,
  type RequestLogInterval,
  type RequestLogPage,
  type RequestLogStats,
  type RequestLogSummary,
  type RequestLogTail,
  type RequestLogTimeseries,
} from '@octap/contracts';
import {
  ConsoleAccessError,
  ConsoleOrganizationsRepository,
} from '#infra/db/repositories/console-organizations.repository.js';
import {
  RequestLogsRepository,
  type RawStats,
  type RequestLogQuery,
  type RequestLogRow,
  type TailPosition,
} from '#infra/db/repositories/request-logs.repository.js';
import type { DrizzleDb } from '#infra/db/postgres.provider.js';

const DAY_MS = 86_400_000;
const DEFAULT_WINDOW_MS = DAY_MS;
/** A little over the retention, so "the last 30 days" in the caller's time zone always fits. */
const MAX_WINDOW_MS = (REQUEST_LOG_RETENTION_DAYS + 1) * DAY_MS;
const INTERVALS: Record<RequestLogInterval, number> = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '1d': 86_400 };
/** The automatic interval is the finest one that keeps the chart at or under this many buckets. */
const AUTO_MAX_BUCKETS = 120;
const MAX_BUCKETS = 1500;
const TOP_ROUTES = 20;
const ERROR_GROUPS = 50;
const TAIL_LIMIT = 100;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILTER_KEYS = ['from', 'to', 'credentialId', 'category', 'method', 'status', 'route'];

type Query = Record<string, unknown>;

/**
 * An organization's API call history (OCT-298), read from the console by its Owner or a Business
 * Developer: the people who build the integration. Every read takes the same filters (time window,
 * key, category, method, status, route); the window defaults to the last 24 hours and spans at most
 * the retention period.
 *
 * What the console builds on it, modelled on Stripe Workbench and the RED method (rate, errors,
 * duration): a filterable list, one call's detail by its request id, a live tail, a summary with
 * p50/p95/p99 latency per category, endpoint and key, a time series for the traffic chart, and
 * failed calls grouped by endpoint and error code.
 */
@Injectable()
export class RequestLogsService {
  constructor(
    private readonly organizations: ConsoleOrganizationsRepository,
    private readonly logs: RequestLogsRepository,
  ) {}

  async list(userId: string, orgId: string, input: Query): Promise<RequestLogPage> {
    allowOnly(input, [...FILTER_KEYS, 'page', 'limit']);
    const query = window(input);
    const page = integer(input.page, 'page', 1, 1, 10_000);
    const limit = integer(input.limit, 'limit', 50, 1, 100);
    const { rows, total } = await this.read(userId, orgId, (tx) => this.logs.list(tx, orgId, query, page, limit));
    return { items: rows.map(toEntry), page, limit, total };
  }

  async detail(userId: string, orgId: string, requestId: string): Promise<RequestLogDetail> {
    const row = await this.read(userId, orgId, (tx) => this.logs.findByRequestId(tx, orgId, requestId));
    if (!row) throw new NotFoundException(`No request ${requestId} was logged for this organization`);
    return { ...toEntry(row), errorBody: row.errorBody ?? null };
  }

  async tail(userId: string, orgId: string, input: Query): Promise<RequestLogTail> {
    allowOnly(input, ['cursor', 'credentialId', 'category', 'method', 'status', 'route']);
    const filters = filtersOf(input);
    if (input.cursor === undefined) {
      const start = await this.read(userId, orgId, (tx) => this.logs.tailStart(tx, orgId, Date.now()));
      return { items: [], cursor: encodeCursor(start) };
    }
    const after = decodeCursor(input.cursor);
    const rows = await this.read(userId, orgId, (tx) => this.logs.since(tx, orgId, after, filters, TAIL_LIMIT));
    const last = rows.at(-1);
    const position = last ? { txId: last.txId, sequence: last.sequence, openedAt: after.openedAt } : after;
    return { items: rows.map(toEntry), cursor: encodeCursor(position) };
  }

  async summary(userId: string, orgId: string, input: Query): Promise<RequestLogSummary> {
    allowOnly(input, FILTER_KEYS);
    const query = window(input);
    const result = await this.read(userId, orgId, (tx) => this.logs.summary(tx, orgId, query, TOP_ROUTES));
    return {
      from: query.from.toISOString(),
      to: query.to.toISOString(),
      totals: toStats(result.totals),
      byCategory: result.byCategory.map(({ category, ...raw }) => ({
        category: category as RequestLogCategory,
        ...toStats(raw),
      })),
      byRoute: result.byRoute.map(({ method, route, ...raw }) => ({ method, route, ...toStats(raw) })),
      byCredential: result.byCredential.map(({ credential, ...raw }) => ({ credential, ...toStats(raw) })),
    };
  }

  /**
   * Buckets start exactly at `from`, so a caller wanting local days or hours passes a `from` at a
   * local boundary. When `from` is left out, the default window is aligned to the interval in UTC.
   */
  async timeseries(userId: string, orgId: string, input: Query): Promise<RequestLogTimeseries> {
    allowOnly(input, [...FILTER_KEYS, 'interval']);
    const query = window(input);
    const span = query.to.getTime() - query.from.getTime();
    const interval = intervalFor(input.interval, span);
    const stepMs = INTERVALS[interval] * 1000;
    if (input.from === undefined) query.from = new Date(Math.floor(query.from.getTime() / stepMs) * stepMs);
    query.to = new Date(
      query.from.getTime() + Math.ceil((query.to.getTime() - query.from.getTime()) / stepMs) * stepMs,
    );
    const buckets = await this.read(userId, orgId, (tx) => this.logs.timeseries(tx, orgId, query, INTERVALS[interval]));
    return {
      from: query.from.toISOString(),
      to: query.to.toISOString(),
      interval,
      buckets: buckets.map(({ start, stats }) => ({
        start: start.toISOString(),
        requests: stats?.requests ?? 0,
        succeeded: stats?.succeeded ?? 0,
        clientErrors: stats?.clientErrors ?? 0,
        serverErrors: stats?.serverErrors ?? 0,
        p95LatencyMs: stats?.p95 ?? null,
      })),
    };
  }

  async errors(userId: string, orgId: string, input: Query): Promise<RequestLogErrorGroup[]> {
    allowOnly(input, FILTER_KEYS);
    const query = window(input);
    const groups = await this.read(userId, orgId, (tx) => this.logs.errorGroups(tx, orgId, query, ERROR_GROUPS));
    return groups.map((group) => ({
      ...group,
      firstSeenAt: new Date(group.firstSeenAt).toISOString(),
      lastSeenAt: new Date(group.lastSeenAt).toISOString(),
    }));
  }

  /** Owner or Business Developer of an ACTIVE organization; anyone else gets 403. */
  private async read<T>(userId: string, orgId: string, action: (tx: DrizzleDb) => Promise<T>): Promise<T> {
    try {
      return await this.organizations.withAccess(userId, orgId, false, action);
    } catch (error) {
      if (error instanceof ConsoleAccessError)
        throw new ForbiddenException('You do not have permission for this organization or operation');
      throw error;
    }
  }
}

/** Opaque to the caller: `<txId>.<sequence>.<openedAt>`, the last row returned and when the tail opened. */
function encodeCursor(position: TailPosition): string {
  return `${position.txId}.${position.sequence}.${position.openedAt}`;
}

function decodeCursor(value: unknown): TailPosition {
  const match = typeof value === 'string' ? /^(-?\d+)\.(\d+)\.(\d+)$/.exec(value) : null;
  const [txId, sequence, openedAt] = match ? [match[1], match[2], match[3]].map(Number) : [NaN, NaN, NaN];
  if (!Number.isSafeInteger(txId) || !Number.isSafeInteger(sequence) || !Number.isSafeInteger(openedAt))
    throw new BadRequestException('cursor must be one a previous tail returned');
  return { txId, sequence, openedAt };
}

function allowOnly(input: Query, keys: string[]): void {
  const unknown = Object.keys(input).filter((key) => !keys.includes(key));
  if (unknown.length) throw new BadRequestException(`Unsupported query fields: ${unknown.join(', ')}`);
}

function integer(value: unknown, name: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    throw new BadRequestException(`${name} must be an integer from ${min} to ${max}`);
  return parsed;
}

function date(value: unknown, name: string): Date | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'string' ? new Date(value) : new Date(NaN);
  if (Number.isNaN(parsed.getTime())) throw new BadRequestException(`${name} must be an ISO 8601 date-time`);
  return parsed;
}

/** `succeeded`, `failed`, a class (`4xx`) or an exact code (`404`), as an inclusive range. */
export function statusRange(value: unknown): { min: number; max: number } | undefined {
  if (value === undefined) return undefined;
  if (value === 'succeeded') return { min: 100, max: 399 };
  if (value === 'failed') return { min: 400, max: 599 };
  if (typeof value === 'string' && /^[1-5]xx$/.test(value)) {
    const base = Number(value[0]) * 100;
    return { min: base, max: base + 99 };
  }
  if (typeof value === 'string' && /^[1-5]\d\d$/.test(value)) return { min: Number(value), max: Number(value) };
  throw new BadRequestException('status must be succeeded, failed, a class such as 4xx, or a code such as 404');
}

function filtersOf(input: Query): Omit<RequestLogQuery, 'from' | 'to'> {
  const filters: Omit<RequestLogQuery, 'from' | 'to'> = {};
  if (input.credentialId !== undefined) {
    if (typeof input.credentialId !== 'string' || !UUID.test(input.credentialId))
      throw new BadRequestException('credentialId must be a UUID');
    filters.credentialId = input.credentialId;
  }
  if (input.category !== undefined) {
    if (!REQUEST_LOG_CATEGORIES.includes(input.category as RequestLogCategory))
      throw new BadRequestException(`category must be one of ${REQUEST_LOG_CATEGORIES.join(', ')}`);
    filters.category = input.category as string;
  }
  if (input.method !== undefined) {
    const method = typeof input.method === 'string' ? input.method.toUpperCase() : '';
    if (!METHODS.includes(method)) throw new BadRequestException(`method must be one of ${METHODS.join(', ')}`);
    filters.method = method;
  }
  if (input.route !== undefined) {
    if (typeof input.route !== 'string' || !input.route.startsWith('/') || input.route.length > 200)
      throw new BadRequestException('route must be a route template such as /v1/credits/earn');
    filters.route = input.route;
  }
  filters.status = statusRange(input.status);
  return filters;
}

/** The filters plus a validated window: the last 24 hours by default, at most the retention period. */
function window(input: Query): RequestLogQuery {
  const to = date(input.to, 'to') ?? new Date();
  const from = date(input.from, 'from') ?? new Date(to.getTime() - DEFAULT_WINDOW_MS);
  if (from.getTime() >= to.getTime()) throw new BadRequestException('from must be before to');
  if (to.getTime() - from.getTime() > MAX_WINDOW_MS)
    throw new BadRequestException(`The window can span at most ${REQUEST_LOG_RETENTION_DAYS} days`);
  return { ...filtersOf(input), from, to };
}

function intervalFor(value: unknown, spanMs: number): RequestLogInterval {
  if (value === undefined) {
    const fits = (Object.keys(INTERVALS) as RequestLogInterval[]).find(
      (interval) => spanMs / (INTERVALS[interval] * 1000) <= AUTO_MAX_BUCKETS,
    );
    return fits ?? '1d';
  }
  if (typeof value !== 'string' || !(value in INTERVALS))
    throw new BadRequestException(`interval must be one of ${Object.keys(INTERVALS).join(', ')}`);
  const interval = value as RequestLogInterval;
  if (spanMs / (INTERVALS[interval] * 1000) > MAX_BUCKETS)
    throw new BadRequestException(`That interval gives more than ${MAX_BUCKETS} buckets; pick a wider one`);
  return interval;
}

function toStats(raw: RawStats): RequestLogStats {
  const failed = raw.clientErrors + raw.serverErrors;
  return {
    requests: raw.requests,
    succeeded: raw.succeeded,
    clientErrors: raw.clientErrors,
    serverErrors: raw.serverErrors,
    errorRate: raw.requests === 0 ? 0 : failed / raw.requests,
    latencyMs: { p50: numberOrNull(raw.p50), p95: numberOrNull(raw.p95), p99: numberOrNull(raw.p99) },
  };
}

function numberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function toEntry(row: RequestLogRow): RequestLogEntry {
  return {
    requestId: row.requestId,
    method: row.method,
    route: row.route,
    path: row.path,
    statusCode: row.statusCode,
    latencyMs: row.latencyMs,
    category: row.category as RequestLogCategory,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    credential: { id: row.credentialId, name: row.credentialName, keyPrefix: row.credentialKeyPrefix },
    userAgent: row.userAgent,
    createdAt: row.createdAt.toISOString(),
  };
}
