import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { CORRELATION_ID_HEADER, CorrelationIdMiddleware, correlationIdOf } from '#observability/correlation-id.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fakeResponse(statusCode = 200) {
  const headers: Record<string, string> = {};
  return Object.assign(new EventEmitter(), {
    statusCode,
    headers,
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
  });
}

describe('CorrelationIdMiddleware', () => {
  it('attaches a fresh id to the request and the response header before calling next', () => {
    const request = { method: 'GET', url: '/v1/credits', headers: {} };
    const response = fakeResponse();
    const next = vi.fn(() => {
      expect(correlationIdOf(request)).toMatch(UUID);
    });

    new CorrelationIdMiddleware().use(request, response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(response.headers[CORRELATION_ID_HEADER]).toBe(correlationIdOf(request));
  });

  it('never reuses a client-sent X-Request-Id, and gives each request its own id', () => {
    const middleware = new CorrelationIdMiddleware();
    const a = { method: 'GET', url: '/', headers: { 'x-request-id': 'planted' } };
    const b = { method: 'GET', url: '/', headers: { 'x-request-id': 'planted' } };
    middleware.use(a, fakeResponse(), () => {});
    middleware.use(b, fakeResponse(), () => {});

    expect(correlationIdOf(a)).not.toBe('planted');
    expect(correlationIdOf(a)).not.toBe(correlationIdOf(b));
  });

  it('logs one access line on finish with the id and without the query string; a 5xx as an error', () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    const middleware = new CorrelationIdMiddleware();

    const ok = { method: 'POST', url: '/x', originalUrl: '/v1/credits/earn?token=secret', headers: {} };
    const okResponse = fakeResponse(201);
    middleware.use(ok, okResponse, () => {});
    expect(log).not.toHaveBeenCalled();
    okResponse.emit('finish');
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^POST /v1/credits/earn 201 \\d+ms requestId=${correlationIdOf(ok)}$`)),
    );

    const failed = { method: 'GET', url: '/health', headers: {} };
    const failedResponse = fakeResponse(503);
    middleware.use(failed, failedResponse, () => {});
    failedResponse.emit('finish');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('GET /health 503'));
    expect(log).toHaveBeenCalledOnce();
  });

  it('gives no id for a request that never went through the middleware', () => {
    expect(correlationIdOf({})).toBeUndefined();
  });
});
