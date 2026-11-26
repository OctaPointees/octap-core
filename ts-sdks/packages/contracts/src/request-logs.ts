/**
 * Request log (OCT-298): every call an organization's API keys made, as the organization's own
 * developers see it in the console. Kept 30 days. Field names follow the OpenTelemetry HTTP
 * semantic conventions where one exists (`route` = `http.route`, `statusCode` =
 * `http.response.status_code`, `latencyMs` = `http.server.request.duration` in milliseconds).
 */

/** What part of the API a call belongs to, from its route. */
export type RequestLogCategory = 'credits' | 'vouchers' | 'refund-policy' | 'webhooks' | 'organizations' | 'other';

export const REQUEST_LOG_CATEGORIES: readonly RequestLogCategory[] = [
  'credits',
  'vouchers',
  'refund-policy',
  'webhooks',
  'organizations',
  'other',
];

/** How many days a request log row is kept. */
export const REQUEST_LOG_RETENTION_DAYS = 30;

/** The API key that made a call, as the console shows it. Never the key itself. */
export interface RequestLogCredentialRef {
  id: string;
  name: string;
  keyPrefix: string;
}

/** One row of the list. */
export interface RequestLogEntry {
  /** The correlation id (`X-Request-Id` on the response): quote it to OctaP support. */
  requestId: string;
  method: string;
  /** The route template, e.g. `/v1/credits/members/:memberId/balance`: groups calls to the same endpoint. */
  route: string;
  /**
   * The path called, without its query string, with only UUID parameters filled in: any other value
   * stays its placeholder (`:memberId`), so no free text or personal data is kept.
   */
  path: string;
  statusCode: number;
  latencyMs: number;
  category: RequestLogCategory;
  /** The `code` of a non-2xx response's error body, when it had one. */
  errorCode: string | null;
  /** The `message` of a non-2xx response's error body. */
  errorMessage: string | null;
  credential: RequestLogCredentialRef;
  /** The caller's `User-Agent`, e.g. the SDK and its version. */
  userAgent: string | null;
  createdAt: string;
}

/** One row with everything recorded about it, including a non-2xx response's full error body. */
export interface RequestLogDetail extends RequestLogEntry {
  errorBody: unknown;
}

/**
 * `succeeded` = 2xx/3xx, `failed` = 4xx/5xx; a class (`4xx`) or an exact code (`404`) narrows it further.
 */
export type RequestLogStatusFilter = 'succeeded' | 'failed' | '2xx' | '3xx' | '4xx' | '5xx' | `${number}`;

/** Filters shared by every request-log read. Times are ISO 8601; the window defaults to the last 24 hours. */
export interface RequestLogFilters {
  from?: string;
  to?: string;
  credentialId?: string;
  category?: RequestLogCategory;
  method?: string;
  status?: RequestLogStatusFilter;
  /** Exact route template, e.g. from a summary row. */
  route?: string;
}

/** `GET …/request-logs`: newest first, `page` from 1, `limit` 1–100 (default 50). */
export interface RequestLogListQuery extends RequestLogFilters {
  page?: number;
  limit?: number;
}

export interface RequestLogPage {
  items: RequestLogEntry[];
  page: number;
  limit: number;
  total: number;
}

/**
 * `GET …/request-logs/tail`: what arrived after `cursor` (at most 100). Without a cursor nothing is
 * returned, only the cursor to poll from: a tail starts now, like `stripe logs tail`, and only shows
 * calls that arrived after it opened. A call is never skipped, even one whose row committed late; it
 * may arrive a moment after newer ones.
 */
export interface RequestLogTailQuery extends Omit<RequestLogFilters, 'from' | 'to'> {
  cursor?: string;
}

export interface RequestLogTail {
  items: RequestLogEntry[];
  /** Opaque. Pass it back on the next poll. */
  cursor: string;
}

export interface LatencyPercentiles {
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

/** Rate, errors, duration for one slice of traffic. `errorRate` is failed / requests, 0–1. */
export interface RequestLogStats {
  requests: number;
  succeeded: number;
  clientErrors: number;
  serverErrors: number;
  errorRate: number;
  latencyMs: LatencyPercentiles;
}

export interface RequestLogSummary {
  from: string;
  to: string;
  totals: RequestLogStats;
  byCategory: (RequestLogStats & { category: RequestLogCategory })[];
  /** The 20 busiest endpoints. */
  byRoute: (RequestLogStats & { method: string; route: string })[];
  byCredential: (RequestLogStats & { credential: RequestLogCredentialRef })[];
}

export type RequestLogInterval = '1m' | '5m' | '15m' | '1h' | '1d';

/** `GET …/request-logs/timeseries`: `interval` defaults to one that gives at most ~100 buckets. */
export interface RequestLogTimeseriesQuery extends RequestLogFilters {
  interval?: RequestLogInterval;
}

export interface RequestLogBucket {
  start: string;
  requests: number;
  succeeded: number;
  clientErrors: number;
  serverErrors: number;
  p95LatencyMs: number | null;
}

export interface RequestLogTimeseries {
  from: string;
  to: string;
  interval: RequestLogInterval;
  /** Every bucket in the window, empty ones included, oldest first. */
  buckets: RequestLogBucket[];
}

/** `GET …/request-logs/errors`: failed calls grouped by endpoint, status and error code, most frequent first. */
export interface RequestLogErrorGroup {
  method: string;
  route: string;
  statusCode: number;
  errorCode: string | null;
  /** The most recent message in the group. */
  errorMessage: string | null;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  /** The most recent call in the group, to open its detail. */
  lastRequestId: string;
}
