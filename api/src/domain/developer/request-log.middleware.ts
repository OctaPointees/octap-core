import { Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import { RequestLogsRepository, type NewApiRequestLog } from '#infra/db/repositories/request-logs.repository.js';
import type { TenantContext } from '#infra/auth/tenant-context.js';
import { correlationIdOf } from '#observability/correlation-id.js';
import { categoryOf } from './request-log-category.js';

/** A non-2xx body bigger than this is stored as a truncated preview. */
export const MAX_ERROR_BODY_BYTES = 8192;
const MAX_USER_AGENT = 256;
const MAX_TEXT = 1000;

interface LoggedRequest {
  method: string;
  originalUrl?: string;
  url: string;
  baseUrl?: string;
  route?: { path?: unknown };
  params?: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
  tenant?: TenantContext;
}

interface LoggedResponse {
  statusCode: number;
  json: (body: unknown) => unknown;
  once(event: 'finish', listener: () => void): unknown;
}

function pathOf(request: LoggedRequest): string {
  const url = request.originalUrl ?? request.url;
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The path called, rebuilt from the route template with only the UUID parameters filled in: an
 * OctaP id is what a developer searches for, while any other value (a mistyped email, a free-text
 * id) stays a placeholder, so no personal data sits in the log for 30 days. Without a template, the
 * path without its query.
 */
export function loggedPathOf(request: LoggedRequest): string {
  const template = request.route?.path;
  if (typeof template !== 'string') return pathOf(request);
  const filled = template.replace(/:(\w+)/g, (placeholder, name: string) => {
    const value = request.params?.[name];
    return typeof value === 'string' && UUID.test(value) ? value : placeholder;
  });
  return `${request.baseUrl ?? ''}${filled}`;
}

/** Writes still in flight. Tests drain them before truncating; nothing in production waits on them. */
const pendingWrites = new Set<Promise<void>>();

/** Resolves once every request-log write started so far has finished, written or failed. */
export async function drainRequestLogWrites(): Promise<void> {
  while (pendingWrites.size > 0) await Promise.allSettled([...pendingWrites]);
}

/** The matched route template (OpenTelemetry `http.route`); the path itself when nothing matched. */
export function routeOf(request: LoggedRequest): string {
  const template = request.route?.path;
  if (typeof template === 'string') return `${request.baseUrl ?? ''}${template}`;
  return pathOf(request);
}

function text(value: unknown, max: number): string | null {
  if (typeof value === 'string') return value.slice(0, max);
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value.join('; ').slice(0, max);
  return null;
}

/** The body as stored: itself when small, otherwise a preview the console can still show. */
export function storedErrorBody(body: unknown): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(body);
  } catch {
    return { truncated: true, preview: String(body).slice(0, MAX_ERROR_BODY_BYTES) };
  }
  if (serialized === undefined) return null;
  if (Buffer.byteLength(serialized) <= MAX_ERROR_BODY_BYTES) return body;
  return { truncated: true, preview: serialized.slice(0, MAX_ERROR_BODY_BYTES) };
}

/**
 * Records one `api_request_logs` row (OCT-298) for every call made with an API key, once the
 * response has finished: method, route, status, latency, category, the correlation id, and a
 * non-2xx response's error body. Only a call `ApiKeyGuard` resolved to a key is recorded: a console
 * session, a public route or an unknown key has no organization to record it under.
 *
 * Best effort, like `lastUsedAt`: the row is written after the response is sent, and a failed write
 * is logged, never retried, never surfaced to the caller. The log is for the merchant's developers,
 * not evidence.
 */
@Injectable()
export class RequestLogMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RequestLogMiddleware.name);

  constructor(private readonly logs: RequestLogsRepository) {}

  use(request: LoggedRequest, response: LoggedResponse, next: () => void): void {
    const receivedAt = new Date();
    const startedAt = process.hrtime.bigint();
    let errorBody: unknown;
    const json = response.json.bind(response);
    response.json = (body: unknown) => {
      if (response.statusCode >= 400) errorBody = body;
      return json(body);
    };
    response.once('finish', () => {
      const tenant = request.tenant;
      const requestId = correlationIdOf(request);
      if (!tenant?.credentialId || !requestId) return;
      const route = routeOf(request);
      const failed = response.statusCode >= 400;
      const body = failed && errorBody && typeof errorBody === 'object' ? (errorBody as Record<string, unknown>) : {};
      const entry: NewApiRequestLog = {
        organizationId: tenant.organizationId,
        credentialId: tenant.credentialId,
        requestId,
        method: request.method,
        route,
        path: loggedPathOf(request),
        statusCode: response.statusCode,
        latencyMs: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
        category: categoryOf(route),
        errorCode: failed ? text(body.code, MAX_TEXT) : null,
        errorMessage: failed ? text(body.message, MAX_TEXT) : null,
        errorBody: failed && errorBody !== undefined ? storedErrorBody(errorBody) : null,
        userAgent: text(request.headers['user-agent'], MAX_USER_AGENT),
        createdAt: receivedAt,
      };
      const write = this.logs
        .record(entry)
        .catch((error: unknown) => {
          this.logger.error(
            `Could not record request ${requestId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        })
        .finally(() => pendingWrites.delete(write));
      pendingWrites.add(write);
    });
    next();
  }
}
