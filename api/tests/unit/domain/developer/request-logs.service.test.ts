import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { RequestLogsService, statusRange } from '#domain/developer/request-logs.service.js';
import {
  ConsoleAccessError,
  type ConsoleOrganizationsRepository,
} from '#infra/db/repositories/console-organizations.repository.js';
import type { RequestLogQuery, RequestLogsRepository } from '#infra/db/repositories/request-logs.repository.js';
import { stub } from '../../../helpers/stub.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-444444444444';

function service(logs: Partial<Record<keyof RequestLogsRepository, unknown>>, denied = false) {
  const withAccess = vi.fn(async (_u: string, _o: string, _m: boolean, action: (tx: never) => Promise<unknown>) => {
    if (denied) throw new ConsoleAccessError();
    return action({} as never);
  });
  return {
    withAccess,
    service: new RequestLogsService(
      stub<ConsoleOrganizationsRepository>({ withAccess }),
      stub<RequestLogsRepository>(logs),
    ),
  };
}

describe('RequestLogsService', () => {
  it('reads under a non-mutating Owner-or-Business-Developer check, and maps a refusal to 403', async () => {
    const list = vi.fn(async () => ({ rows: [], total: 0 }));
    const allowed = service({ list });
    await allowed.service.list(USER, ORG, {});
    expect(allowed.withAccess).toHaveBeenCalledWith(USER, ORG, false, expect.any(Function));

    await expect(service({ list }, true).service.list(USER, ORG, {})).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('defaults to the last 24 hours, page 1 of 50', async () => {
    const list = vi.fn<(tx: unknown, org: string, q: RequestLogQuery, page: number, limit: number) => Promise<unknown>>(
      async () => ({ rows: [], total: 0 }),
    );
    const result = await service({ list }).service.list(USER, ORG, {});
    const [, , query, page, limit] = list.mock.calls[0];
    expect(query.to.getTime() - query.from.getTime()).toBe(86_400_000);
    expect([page, limit]).toEqual([1, 50]);
    expect(result).toEqual({ items: [], page: 1, limit: 50, total: 0 });
  });

  it.each([
    [{ limit: '101' }],
    [{ page: '0' }],
    [{ status: 'teapot' }],
    [{ method: 'TRACE' }],
    [{ category: 'billing' }],
    [{ credentialId: 'not-a-uuid' }],
    [{ from: 'yesterday' }],
    [{ from: '2026-11-02T00:00:00Z', to: '2026-11-01T00:00:00Z' }],
    [{ from: '2026-09-01T00:00:00Z', to: '2026-11-01T00:00:00Z' }],
    [{ sort: 'asc' }],
  ])('rejects %j with 400', async (input) => {
    const list = vi.fn();
    await expect(service({ list }).service.list(USER, ORG, input)).rejects.toBeInstanceOf(BadRequestException);
    expect(list).not.toHaveBeenCalled();
  });

  it('turns a status filter into an inclusive code range', () => {
    expect(statusRange('succeeded')).toEqual({ min: 100, max: 399 });
    expect(statusRange('failed')).toEqual({ min: 400, max: 599 });
    expect(statusRange('4xx')).toEqual({ min: 400, max: 499 });
    expect(statusRange('404')).toEqual({ min: 404, max: 404 });
    expect(statusRange(undefined)).toBeUndefined();
  });

  it('answers 404 for a request id it never logged', async () => {
    const findByRequestId = vi.fn(async () => undefined);
    await expect(
      service({ findByRequestId }).service.detail(USER, ORG, '55555555-5555-4555-8555-555555555555'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('starts a tail at the latest row without returning any', async () => {
    const latestSequence = vi.fn(async () => 42);
    const since = vi.fn();
    expect(await service({ latestSequence, since }).service.tail(USER, ORG, {})).toEqual({ items: [], cursor: '42' });
    expect(since).not.toHaveBeenCalled();
  });

  it('keeps the cursor when nothing new arrived', async () => {
    const since = vi.fn(async () => []);
    expect(await service({ since }).service.tail(USER, ORG, { cursor: '42' })).toEqual({ items: [], cursor: '42' });
  });

  it('picks the finest interval that keeps the chart at or under 120 buckets', async () => {
    const timeseries = vi.fn(async () => []);
    const { service: svc } = service({ timeseries });
    const day = await svc.timeseries(USER, ORG, { from: '2026-11-25T00:00:00Z', to: '2026-11-26T00:00:00Z' });
    expect(day.interval).toBe('15m');
    const hour = await svc.timeseries(USER, ORG, { from: '2026-11-25T00:00:00Z', to: '2026-11-25T01:00:00Z' });
    expect(hour.interval).toBe('1m');
    const month = await svc.timeseries(USER, ORG, { from: '2026-10-27T00:00:00Z', to: '2026-11-26T00:00:00Z' });
    expect(month.interval).toBe('1d');
  });

  it('refuses an interval that would draw more than 1500 buckets', async () => {
    const timeseries = vi.fn(async () => []);
    await expect(
      service({ timeseries }).service.timeseries(USER, ORG, {
        from: '2026-10-27T00:00:00Z',
        to: '2026-11-26T00:00:00Z',
        interval: '1m',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('computes the error rate from client and server errors', async () => {
    const summary = vi.fn(async () => ({
      totals: { requests: 10, succeeded: 7, clientErrors: 2, serverErrors: 1, p50: 12, p95: 80, p99: 120 },
      byCategory: [],
      byRoute: [],
      byCredential: [],
    }));
    const result = await service({ summary }).service.summary(USER, ORG, {});
    expect(result.totals).toEqual({
      requests: 10,
      succeeded: 7,
      clientErrors: 2,
      serverErrors: 1,
      errorRate: 0.3,
      latencyMs: { p50: 12, p95: 80, p99: 120 },
    });
  });
});
