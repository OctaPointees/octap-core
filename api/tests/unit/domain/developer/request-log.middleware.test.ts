import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_ERROR_BODY_BYTES,
  RequestLogMiddleware,
  loggedPathOf,
  routeOf,
  storedErrorBody,
} from '#domain/developer/request-log.middleware.js';
import { categoryOf } from '#domain/developer/request-log-category.js';
import type { NewApiRequestLog, RequestLogsRepository } from '#infra/db/repositories/request-logs.repository.js';
import { stub } from '../../../helpers/stub.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const KEY = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = '33333333-3333-4333-8333-333333333333';

function fakeResponse() {
  const emitter = new EventEmitter();
  const sent: unknown[] = [];
  const response = {
    statusCode: 200,
    json: (body: unknown) => sent.push(body),
    once: (event: 'finish', listener: () => void) => emitter.once(event, listener),
    finish: () => emitter.emit('finish'),
    sent,
  };
  return response;
}

function run(
  request: Record<string, unknown>,
  respond: (res: ReturnType<typeof fakeResponse>) => void,
  record = vi.fn<(entry: NewApiRequestLog) => Promise<void>>(async () => {}),
) {
  const middleware = new RequestLogMiddleware(stub<RequestLogsRepository>({ record }));
  const response = fakeResponse();
  const req = {
    method: 'GET',
    url: '/v1/credits/members/44444444-4444-4444-8444-444444444444/balance?programId=x',
    baseUrl: '',
    headers: { 'user-agent': '@octap/node/0.1.0' },
    correlationId: REQUEST_ID,
    ...request,
  };
  middleware.use(req as never, response as never, () => {});
  respond(response);
  response.finish();
  return { record, response };
}

describe('RequestLogMiddleware', () => {
  it('records a call made with an API key once the response finishes, under the route template', () => {
    const { record } = run(
      {
        tenant: { organizationId: ORG, credentialId: KEY, scopes: ['read'] },
        route: { path: '/v1/credits/members/:memberId/balance' },
        params: { memberId: '44444444-4444-4444-8444-444444444444' },
      },
      (res) => res.json({ balance: 10 }),
    );
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0][0]).toMatchObject({
      organizationId: ORG,
      credentialId: KEY,
      requestId: REQUEST_ID,
      method: 'GET',
      route: '/v1/credits/members/:memberId/balance',
      path: '/v1/credits/members/44444444-4444-4444-8444-444444444444/balance',
      statusCode: 200,
      category: 'credits',
      errorCode: null,
      errorMessage: null,
      errorBody: null,
      userAgent: '@octap/node/0.1.0',
    });
  });

  it('keeps a failed call’s error body, code and message, never a successful body', () => {
    const body = { statusCode: 409, code: 'API_CREDENTIAL_LIMIT_REACHED', message: 'Revoke one first' };
    const { record, response } = run(
      { tenant: { organizationId: ORG, credentialId: KEY, scopes: ['write'] }, route: { path: '/v1/credits/earn' } },
      (res) => {
        res.statusCode = 409;
        res.json(body);
      },
    );
    expect(response.sent).toEqual([body]);
    expect(record.mock.calls[0][0]).toMatchObject({
      statusCode: 409,
      errorCode: 'API_CREDENTIAL_LIMIT_REACHED',
      errorMessage: 'Revoke one first',
      errorBody: body,
    });
  });

  it('joins a validation error’s message list', () => {
    const { record } = run(
      { tenant: { organizationId: ORG, credentialId: KEY, scopes: ['write'] }, route: { path: '/v1/credits/earn' } },
      (res) => {
        res.statusCode = 400;
        res.json({ statusCode: 400, message: ['a is required', 'b is required'] });
      },
    );
    expect(record.mock.calls[0][0].errorMessage).toBe('a is required; b is required');
  });

  it('records nothing without an API key: console sessions, public routes, unknown keys', () => {
    const { record } = run({}, (res) => {
      res.statusCode = 401;
      res.json({ message: 'API credential is invalid' });
    });
    expect(record).not.toHaveBeenCalled();
  });

  it('logs a failed write and leaves the response alone', async () => {
    const record = vi.fn(async () => {
      throw new Error('db down');
    });
    const { response } = run(
      { tenant: { organizationId: ORG, credentialId: KEY, scopes: ['read'] }, route: { path: '/v1/rewards/vouchers' } },
      (res) => res.json([]),
      record,
    );
    await vi.waitFor(() => expect(record).toHaveBeenCalledOnce());
    expect(response.sent).toEqual([[]]);
  });
});

describe('request log helpers', () => {
  it('stores a body over the cap as a truncated preview', () => {
    const big = { message: 'x'.repeat(MAX_ERROR_BODY_BYTES * 2) };
    const stored = storedErrorBody(big) as { truncated: boolean; preview: string };
    expect(stored.truncated).toBe(true);
    expect(stored.preview).toHaveLength(MAX_ERROR_BODY_BYTES);
    expect(storedErrorBody({ message: 'small' })).toEqual({ message: 'small' });
  });

  it('fills only UUID parameters into the logged path, so free text never lands in the log', () => {
    const request = {
      method: 'GET',
      url: '/v1/credits/members/jane@example.com/balance',
      baseUrl: '',
      route: { path: '/v1/credits/members/:memberId/balance' },
      params: { memberId: 'jane@example.com' },
      headers: {},
    };
    expect(loggedPathOf(request)).toBe('/v1/credits/members/:memberId/balance');
    expect(loggedPathOf({ method: 'GET', url: '/v1/x?token=1', headers: {} })).toBe('/v1/x');
  });

  it('falls back to the path when no route matched', () => {
    expect(routeOf({ method: 'GET', url: '/v1/nope?x=1', headers: {} })).toBe('/v1/nope');
    expect(routeOf({ method: 'GET', url: '/x', baseUrl: '/v1', route: { path: '/credits/earn' }, headers: {} })).toBe(
      '/v1/credits/earn',
    );
  });

  it.each([
    ['/v1/credits/earn', 'credits'],
    ['/v1/credits/members/:memberId/balance', 'credits'],
    ['/v1/rewards/vouchers/:id/claim', 'vouchers'],
    ['/v1/rewards/voucher-batches', 'vouchers'],
    ['/v1/rewards/refund-policy/history', 'refund-policy'],
    ['/v1/webhooks/deliveries', 'webhooks'],
    ['/v1/organizations/resolve/:slug', 'organizations'],
    ['/v1/identity/session', 'other'],
    ['/health', 'other'],
  ])('puts %s under %s', (route, category) => {
    expect(categoryOf(route)).toBe(category);
  });
});
