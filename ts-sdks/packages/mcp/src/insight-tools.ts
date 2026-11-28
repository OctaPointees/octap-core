import type { McpServer } from '@modelcontextprotocol/server';
import type { LoyaltyTransactionDto } from '@octap/sdk';
import * as z from 'zod/v4';
import { TRANSACTION, transactionOf } from './shapes.js';
import { nullableNumber, nullableString, orNull, registerRead, type Projection } from './tool-kit.js';

interface RequestOptions {
  signal?: AbortSignal;
}

/** `GET …/transactions`: the organization's whole ledger, newest first. */
export interface TransactionSearch {
  type?: string;
  status?: string;
  memberId?: string;
  limit?: number;
  cursor?: string;
}

/** The request log filters every `…/request-logs` read takes (OCT-298). */
export interface RequestLogFilters {
  from?: string;
  to?: string;
  category?: string;
  method?: string;
  status?: string;
  route?: string;
}

interface Stats {
  requests: number;
  succeeded: number;
  clientErrors: number;
  serverErrors: number;
  errorRate: number;
  latencyMs?: { p50?: number | null; p95?: number | null; p99?: number | null } | null;
}

interface CredentialRef {
  id: string;
  name: string;
  keyPrefix: string;
}

export interface RequestLogEntryView {
  requestId: string;
  method: string;
  route: string;
  path: string;
  statusCode: number;
  latencyMs: number;
  category: string;
  errorCode: string | null;
  errorMessage: string | null;
  credential: CredentialRef | null;
  userAgent: string | null;
  createdAt: string;
}

export interface ProgramAnalyticsView {
  from: string;
  to: string;
  circulation: { earned: number; redeemed: number; reversed: number; net: number };
  engagement: { activeMembers: number; enrolledMembers: number };
  vouchers: { claimed: number; redeemed: number; expiredUnused: number };
  dailyTrend: Array<{ start: string; earned: number; redeemed: number }>;
}

export interface ApiErrorGroupView {
  method: string;
  route: string;
  statusCode: number;
  errorCode: string | null;
  errorMessage: string | null;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastRequestId: string;
}

export interface ApiUsageView {
  from: string;
  to: string;
  totals: Stats;
  byCategory: Array<Stats & { category: string }>;
  byRoute: Array<Stats & { method: string; route: string }>;
  byCredential: Array<Stats & { credential: CredentialRef | null }>;
}

/** Reads for the program and integration insight tools: the console client has them (`serve-http`). */
export interface InsightReads {
  consoleTransactions(
    search: TransactionSearch,
    options?: RequestOptions,
  ): Promise<{ items: LoyaltyTransactionDto[]; nextCursor: string | null }>;
  getProgramAnalytics(range: { from?: string; to?: string }, options?: RequestOptions): Promise<ProgramAnalyticsView>;
  searchRequestLogs(
    query: RequestLogFilters & { page?: number; limit?: number },
    options?: RequestOptions,
  ): Promise<{ items: RequestLogEntryView[]; page: number; limit: number; total: number }>;
  getRequestLog(requestId: string, options?: RequestOptions): Promise<RequestLogEntryView>;
  getApiErrors(filters: RequestLogFilters, options?: RequestOptions): Promise<ApiErrorGroupView[]>;
  getApiUsage(filters: RequestLogFilters, options?: RequestOptions): Promise<ApiUsageView>;
}

export type InsightToolName =
  | 'list_transactions'
  | 'get_program_analytics'
  | 'search_request_logs'
  | 'get_request_log'
  | 'get_api_errors'
  | 'get_api_usage';

/** The read each insight tool needs from the client. */
export const INSIGHT_READ: Record<InsightToolName, keyof InsightReads> = {
  list_transactions: 'consoleTransactions',
  get_program_analytics: 'getProgramAnalytics',
  search_request_logs: 'searchRequestLogs',
  get_request_log: 'getRequestLog',
  get_api_errors: 'getApiErrors',
  get_api_usage: 'getApiUsage',
};

export const INSIGHT_TOOLS = Object.keys(INSIGHT_READ) as InsightToolName[];

// -------------------------------------------------------------------------------------------------
// Inputs and answers: whitelisted fields only.
// -------------------------------------------------------------------------------------------------

const DATE = z
  .string()
  .datetime({ offset: true })
  .describe('ISO 8601 with a time zone, e.g. 2026-11-01T00:00:00+07:00');
const RANGE = {
  from: DATE.optional().describe('Start; defaults to 30 days before `to`'),
  to: DATE.optional().describe('End; defaults to now'),
};
const LOG_FILTERS = {
  ...RANGE,
  category: z.enum(['credits', 'organizations', 'other', 'refund-policy', 'vouchers', 'webhooks']).optional(),
  method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']).optional(),
  status: z
    .string()
    .regex(/^([1-5]\d\d|[1-5]xx|failed|succeeded)$/)
    .optional()
    .describe('An exact code (404), a class (4xx), or failed / succeeded'),
  route: z.string().max(300).optional().describe('An exact route template, e.g. /v1/credits/earn'),
};

const LATENCY = z
  .object({ p50: nullableNumber, p95: nullableNumber, p99: nullableNumber })
  .nullable()
  .describe('Milliseconds');
const STATS = {
  requests: z.number(),
  succeeded: z.number(),
  clientErrors: z.number().describe('4xx'),
  serverErrors: z.number().describe('5xx'),
  errorRate: z.number().describe('Failed share, 0 to 1'),
  latencyMs: LATENCY,
};
const API_KEY = z
  .object({ name: nullableString, keyPrefix: nullableString })
  .nullable()
  .describe('The key that called');

const REQUEST_LOG = z.object({
  requestId: z.string().describe('X-Request-Id; quote it to OctaP support'),
  method: z.string(),
  route: z.string(),
  path: z.string().describe('Only UUIDs filled in; other values stay placeholders'),
  statusCode: z.number(),
  latencyMs: z.number(),
  category: z.string(),
  errorCode: nullableString,
  errorMessage: nullableString,
  apiKey: API_KEY,
  userAgent: nullableString,
  createdAt: z.string(),
});

const statsOf = (stats: Stats) => ({
  requests: stats.requests,
  succeeded: stats.succeeded,
  clientErrors: stats.clientErrors,
  serverErrors: stats.serverErrors,
  errorRate: stats.errorRate,
  latencyMs: stats.latencyMs
    ? { p50: orNull(stats.latencyMs.p50), p95: orNull(stats.latencyMs.p95), p99: orNull(stats.latencyMs.p99) }
    : null,
});
const keyOf = (credential: CredentialRef | null | undefined) =>
  credential ? { name: orNull(credential.name), keyPrefix: orNull(credential.keyPrefix) } : null;

/** A request log row. Its full error body is left out: the code and message say what went wrong. */
function requestLogOf(entry: RequestLogEntryView): z.infer<typeof REQUEST_LOG> {
  return {
    requestId: entry.requestId,
    method: entry.method,
    route: entry.route,
    path: entry.path,
    statusCode: entry.statusCode,
    latencyMs: entry.latencyMs,
    category: entry.category,
    errorCode: orNull(entry.errorCode),
    errorMessage: orNull(entry.errorMessage),
    apiKey: keyOf(entry.credential),
    userAgent: orNull(entry.userAgent),
    createdAt: entry.createdAt,
  };
}

const definedOnly = <T extends Record<string, unknown>>(value: T) =>
  Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as Partial<T>;

/**
 * Insight reads: the organization's ledger, how the program is doing, and how its integration calls
 * the API (OCT-314 part 2). For an Owner and a Business Developer alike, as Core allows.
 */
export function registerInsightTools<Name extends string>(
  server: McpServer,
  core: Partial<InsightReads>,
  allowed: ReadonlySet<string>,
  projection?: Projection<Name>,
) {
  const has = (tool: InsightToolName) => allowed.has(tool) && typeof core[INSIGHT_READ[tool]] === 'function';
  const call = <K extends keyof InsightReads>(key: K): InsightReads[K] =>
    (core[key] as unknown as (...args: unknown[]) => unknown).bind(core) as InsightReads[K];
  const project = projection as Projection<string> | undefined;

  if (has('list_transactions')) {
    const list = call('consoleTransactions');
    registerRead(
      server,
      'list_transactions',
      {
        description:
          "The organization's points transactions across every member, newest first, a page at a time: filter " +
          'by type (EARN, REDEEM, REVERSAL, …), status (PENDING, CONFIRMED, FAILED, REVERSED) or member. Pass ' +
          'nextCursor back as cursor for the next page.',
        input: z
          .object({
            type: z.enum(['ADJUSTMENT', 'EARN', 'EXPIRY', 'REDEEM', 'REVERSAL', 'TRANSFER']).optional(),
            status: z.enum(['CONFIRMED', 'FAILED', 'PENDING', 'REVERSED']).optional(),
            memberId: z.string().uuid().optional().describe('From find_member'),
            limit: z.number().int().min(1).max(50).default(20),
            cursor: z.string().min(1).max(500).optional(),
          })
          .strict(),
        output: z.object({
          transactions: z.array(TRANSACTION.extend({ memberId: nullableString })),
          nextCursor: nullableString,
        }),
        run: async (args, signal) => {
          const page = await list(definedOnly(args), { signal });
          return {
            transactions: page.items.map((tx) => ({
              ...transactionOf(tx),
              memberId: orNull(tx.organizationEndUserId),
            })),
            nextCursor: orNull(page.nextCursor),
          };
        },
      },
      project,
    );
  }

  if (has('get_program_analytics')) {
    const summary = call('getProgramAnalytics');
    registerRead(
      server,
      'get_program_analytics',
      {
        description:
          'How the loyalty program did over a period (default: the last 30 days): points earned, redeemed and ' +
          'reversed, active versus enrolled members, vouchers claimed, redeemed and expired unused, and a daily trend.',
        input: z.object(RANGE).strict(),
        output: z.object({
          from: z.string(),
          to: z.string(),
          circulation: z.object({ earned: z.number(), redeemed: z.number(), reversed: z.number(), net: z.number() }),
          engagement: z.object({ activeMembers: z.number(), enrolledMembers: z.number() }),
          vouchers: z.object({ claimed: z.number(), redeemed: z.number(), expiredUnused: z.number() }),
          dailyTrend: z.array(z.object({ start: z.string(), earned: z.number(), redeemed: z.number() })),
        }),
        run: async (args, signal) => {
          const value = await summary(definedOnly(args), { signal });
          return {
            from: value.from,
            to: value.to,
            circulation: {
              earned: value.circulation.earned,
              redeemed: value.circulation.redeemed,
              reversed: value.circulation.reversed,
              net: value.circulation.net,
            },
            engagement: {
              activeMembers: value.engagement.activeMembers,
              enrolledMembers: value.engagement.enrolledMembers,
            },
            vouchers: {
              claimed: value.vouchers.claimed,
              redeemed: value.vouchers.redeemed,
              expiredUnused: value.vouchers.expiredUnused,
            },
            dailyTrend: value.dailyTrend.map((day) => ({
              start: day.start,
              earned: day.earned,
              redeemed: day.redeemed,
            })),
          };
        },
      },
      project,
    );
  }

  if (has('search_request_logs')) {
    const search = call('searchRequestLogs');
    registerRead(
      server,
      'search_request_logs',
      {
        description:
          "The organization's API calls (from its API keys), newest first, filtered by time, category, method, " +
          'status (404, 4xx, failed…) or route. Use it to find the call behind a failure, then get_request_log.',
        input: z
          .object({
            ...LOG_FILTERS,
            page: z.number().int().min(1).default(1),
            limit: z.number().int().min(1).max(50).default(20),
          })
          .strict(),
        output: z.object({ requests: z.array(REQUEST_LOG), page: z.number(), total: z.number() }),
        run: async (args, signal) => {
          const page = await search(definedOnly(args), { signal });
          return { requests: page.items.map(requestLogOf), page: page.page, total: page.total };
        },
      },
      project,
    );
  }

  if (has('get_request_log')) {
    const detail = call('getRequestLog');
    registerRead(
      server,
      'get_request_log',
      {
        description:
          'One API call by its request id (X-Request-Id): route, status, latency, error code and message, and the ' +
          'API key that made it.',
        input: z
          .object({ requestId: z.string().min(1).max(100).describe('From search_request_logs or a response header') })
          .strict(),
        output: REQUEST_LOG,
        notFound: 'No API call with this request id in the connected organization.',
        run: async (args, signal) => requestLogOf(await detail(args.requestId, { signal })),
      },
      project,
    );
  }

  if (has('get_api_errors')) {
    const errors = call('getApiErrors');
    registerRead(
      server,
      'get_api_errors',
      {
        description:
          "The organization's failing API calls grouped by route, status and error, most frequent first, with when " +
          'each started and the last request id to look at.',
        input: z.object(LOG_FILTERS).strict(),
        output: z.object({
          errors: z.array(
            z.object({
              method: z.string(),
              route: z.string(),
              statusCode: z.number(),
              errorCode: nullableString,
              errorMessage: nullableString,
              count: z.number(),
              firstSeenAt: z.string(),
              lastSeenAt: z.string(),
              lastRequestId: z.string(),
            }),
          ),
        }),
        run: async (args, signal) => ({
          errors: (await errors(definedOnly(args), { signal })).map((group) => ({
            method: group.method,
            route: group.route,
            statusCode: group.statusCode,
            errorCode: orNull(group.errorCode),
            errorMessage: orNull(group.errorMessage),
            count: group.count,
            firstSeenAt: group.firstSeenAt,
            lastSeenAt: group.lastSeenAt,
            lastRequestId: group.lastRequestId,
          })),
        }),
      },
      project,
    );
  }

  if (has('get_api_usage')) {
    const usage = call('getApiUsage');
    registerRead(
      server,
      'get_api_usage',
      {
        description:
          "How the organization's integration uses the API over a period: request count, error rate and latency " +
          '(p50/p95/p99) in total, per category, for the 20 busiest routes, and per API key.',
        input: z.object(LOG_FILTERS).strict(),
        output: z.object({
          from: z.string(),
          to: z.string(),
          totals: z.object(STATS),
          byCategory: z.array(z.object({ category: z.string(), ...STATS })),
          byRoute: z.array(z.object({ method: z.string(), route: z.string(), ...STATS })),
          byApiKey: z.array(z.object({ apiKey: API_KEY, ...STATS })),
        }),
        run: async (args, signal) => {
          const value = await usage(definedOnly(args), { signal });
          return {
            from: value.from,
            to: value.to,
            totals: statsOf(value.totals),
            byCategory: value.byCategory.map((row) => ({ category: row.category, ...statsOf(row) })),
            byRoute: value.byRoute.map((row) => ({ method: row.method, route: row.route, ...statsOf(row) })),
            byApiKey: value.byCredential.map((row) => ({ apiKey: keyOf(row.credential), ...statsOf(row) })),
          };
        },
      },
      project,
    );
  }
}
