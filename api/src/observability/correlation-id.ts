import { Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

/** Response header carrying the request's correlation id, so a caller can quote it to support. */
export const CORRELATION_ID_HEADER = 'X-Request-Id';

/** What `CorrelationIdMiddleware` adds to every HTTP request before any guard or handler runs. */
export interface CorrelatedRequest {
  correlationId: string;
}

interface IncomingRequest extends Partial<CorrelatedRequest> {
  method: string;
  originalUrl?: string;
  url: string;
}

interface OutgoingResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  once(event: 'finish', listener: () => void): unknown;
}

/**
 * The correlation id of a request that went through `CorrelationIdMiddleware`, for anything that
 * persists or forwards it (OCT-46's request log, a webhook, an error report). The same id is in
 * the `X-Request-Id` response header and in this process's access log line for the request.
 */
export function correlationIdOf(request: object): string | undefined {
  return (request as Partial<CorrelatedRequest>).correlationId;
}

/** The path without its query string: a query can carry ids or tokens that do not belong in logs. */
function pathOf(request: IncomingRequest): string {
  const url = request.originalUrl ?? request.url;
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}

/**
 * Gives every HTTP request one server-generated correlation id: on the request
 * (`request.correlationId`), in the `X-Request-Id` response header, and in one access log line
 * when the response finishes. A client-sent `X-Request-Id` is ignored, so the id is always unique
 * and always ours — a caller cannot make two requests share one, or plant a misleading id in our logs.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(request: IncomingRequest, response: OutgoingResponse, next: () => void): void {
    const correlationId = randomUUID();
    const startedAt = process.hrtime.bigint();
    request.correlationId = correlationId;
    response.setHeader(CORRELATION_ID_HEADER, correlationId);
    response.once('finish', () => {
      const latencyMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
      const line = `${request.method} ${pathOf(request)} ${response.statusCode} ${latencyMs}ms requestId=${correlationId}`;
      if (response.statusCode >= 500) this.logger.error(line);
      else this.logger.log(line);
    });
    next();
  }
}
