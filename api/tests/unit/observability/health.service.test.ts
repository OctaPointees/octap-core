import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { SuiTransactionBuilderClient } from '#infra/clients/sui/sui-transaction-builder.client.js';
import type { OperationalHealthRepository } from '#infra/db/repositories/operational-health.repository.js';
import { HEALTH_CHECK_TIMEOUT_MS, HealthService, PUBLIC_HEALTH_CACHE_MS } from '#observability/health.service.js';
import { stub } from '../../helpers/stub.js';

type Repo = OperationalHealthRepository;

function build(
  overrides: {
    ping?: () => Promise<void>;
    redisPing?: () => Promise<string>;
    latestCheckpoint?: () => Promise<bigint>;
    unsettledOperations?: Repo['unsettledOperations'];
    webhookBacklog?: Repo['webhookBacklog'];
    indexerStreams?: Repo['indexerStreams'];
  } = {},
) {
  const repository = stub<Repo>({
    ping: vi.fn(overrides.ping ?? (async () => {})),
    unsettledOperations: vi.fn(overrides.unsettledOperations ?? (async () => [])),
    webhookBacklog: vi.fn(
      overrides.webhookBacklog ?? (async () => ({ pending: 0, due: 0, oldestDueAgeSeconds: null, deadLettered: 0 })),
    ),
    indexerStreams: vi.fn(overrides.indexerStreams ?? (async () => [])),
  });
  const redis = stub<Redis>({ ping: vi.fn(overrides.redisPing ?? (async () => 'PONG')) });
  const sui = stub<SuiTransactionBuilderClient>({
    latestCheckpoint: vi.fn(overrides.latestCheckpoint ?? (async () => 1_000n)),
  });
  return { service: new HealthService(repository, redis, sui), repository, sui };
}

const down = (message: string) => async (): Promise<never> => {
  throw new Error(message);
};

afterEach(() => {
  vi.useRealTimers();
});

describe('HealthService.platformReport', () => {
  it('is ok when every dependency answers, and reports worker lag', async () => {
    const { service } = build({
      unsettledOperations: async () => [
        { commandType: 'CREDIT_EARN_CHAIN_SUBMIT', status: 'PENDING', count: 3, oldestAgeSeconds: 120 },
        { commandType: 'CREDIT_EARN_CHAIN_SUBMIT', status: 'UNKNOWN', count: 1, oldestAgeSeconds: 40 },
      ],
      webhookBacklog: async () => ({ pending: 5, due: 2, oldestDueAgeSeconds: 30, deadLettered: 1 }),
      indexerStreams: async () => [
        {
          streamName: 'octap::credit_account',
          lastCheckpoint: '900',
          caughtUpCheckpoint: '950',
          sinceUpdateSeconds: 4,
        },
      ],
    });

    const report = await service.platformReport();

    expect(report.status).toBe('ok');
    expect(report.checks.database).toEqual({ status: 'up', latencyMs: expect.any(Number) });
    expect(report.workerLag).toEqual({
      operations: {
        oldestWorkerOwedAgeSeconds: 120,
        byCommandType: [
          {
            commandType: 'CREDIT_EARN_CHAIN_SUBMIT',
            status: 'PENDING',
            count: 3,
            oldestAgeSeconds: 120,
            awaitingCustomer: false,
          },
          {
            commandType: 'CREDIT_EARN_CHAIN_SUBMIT',
            status: 'UNKNOWN',
            count: 1,
            oldestAgeSeconds: 40,
            awaitingCustomer: false,
          },
        ],
      },
      webhookDeliveries: { pending: 5, due: 2, oldestDueAgeSeconds: 30, deadLettered: 1 },
      indexer: [
        {
          streamName: 'octap::credit_account',
          lastCheckpoint: '900',
          caughtUpCheckpoint: '950',
          chainCheckpoint: '1000',
          checkpointsBehind: '50',
          sinceUpdateSeconds: 4,
        },
      ],
    });
  });

  it('reports an empty system as null ages and zero counts', async () => {
    const { service } = build({ webhookBacklog: async () => undefined as never });
    expect((await service.platformReport()).workerLag).toEqual({
      operations: { oldestWorkerOwedAgeSeconds: null, byCommandType: [] },
      webhookDeliveries: { pending: 0, due: 0, oldestDueAgeSeconds: null, deadLettered: 0 },
      indexer: [],
    });
  });

  it('leaves PENDING customer-signed commands out of the headline age, but not once they are UNKNOWN', async () => {
    const { service } = build({
      unsettledOperations: async () => [
        { commandType: 'CREDIT_POS_REDEEM_RESERVE', status: 'PENDING', count: 1, oldestAgeSeconds: 9000 },
        { commandType: 'VOUCHER_CLAIM_RESERVE', status: 'PENDING', count: 1, oldestAgeSeconds: 8000 },
        { commandType: 'VOUCHER_USE_RESERVE', status: 'PENDING', count: 1, oldestAgeSeconds: 7000 },
        { commandType: 'CREDIT_EARN_CHAIN_SUBMIT', status: 'PENDING', count: 2, oldestAgeSeconds: 60 },
      ],
    });
    const operations = (await service.platformReport()).workerLag?.operations;
    expect(operations?.oldestWorkerOwedAgeSeconds).toBe(60);
    expect(operations?.byCommandType.map((g) => g.awaitingCustomer)).toEqual([true, true, true, false]);

    const onlyCustomer = build({
      unsettledOperations: async () => [
        { commandType: 'VOUCHER_USE_RESERVE', status: 'PENDING', count: 1, oldestAgeSeconds: 7000 },
      ],
    });
    expect((await onlyCustomer.service.platformReport()).workerLag?.operations.oldestWorkerOwedAgeSeconds).toBeNull();

    const unknown = build({
      unsettledOperations: async () => [
        { commandType: 'CREDIT_POS_REDEEM_RESERVE', status: 'UNKNOWN', count: 1, oldestAgeSeconds: 500 },
      ],
    });
    expect((await unknown.service.platformReport()).workerLag?.operations).toMatchObject({
      oldestWorkerOwedAgeSeconds: 500,
      byCommandType: [{ awaitingCustomer: false }],
    });
  });

  it('is degraded, not down, when only Sui is unreachable; indexer lag is then unknown', async () => {
    const { service } = build({
      latestCheckpoint: down('fetch failed'),
      indexerStreams: async () => [
        { streamName: 's', lastCheckpoint: '10', caughtUpCheckpoint: null, sinceUpdateSeconds: 1 },
        { streamName: 't', lastCheckpoint: null, caughtUpCheckpoint: null, sinceUpdateSeconds: 1 },
      ],
    });

    const report = await service.platformReport();

    expect(report.status).toBe('degraded');
    expect(report.checks.sui).toEqual({ status: 'down', latencyMs: expect.any(Number), error: 'fetch failed' });
    expect(report.workerLag?.indexer.map((s) => [s.chainCheckpoint, s.checkpointsBehind])).toEqual([
      [null, null],
      [null, null],
    ]);
  });

  it('never reports a stream ahead of the answering node as negative lag', async () => {
    const { service } = build({
      latestCheckpoint: async () => 100n,
      indexerStreams: async () => [
        { streamName: 's', lastCheckpoint: '105', caughtUpCheckpoint: null, sinceUpdateSeconds: 0 },
      ],
    });
    expect((await service.platformReport()).workerLag?.indexer[0].checkpointsBehind).toBe('0');
  });

  it('is down when Redis is unreachable', async () => {
    const { service } = build({ redisPing: down('Connection is closed.') });
    const report = await service.platformReport();
    expect(report.status).toBe('down');
    expect(report.checks.redis.error).toBe('Connection is closed.');
  });

  it('is down with no lag when the database is unreachable, without querying it further', async () => {
    const { service, repository } = build({ ping: down('ECONNREFUSED') });
    const report = await service.platformReport();
    expect(report.status).toBe('down');
    expect(report.workerLag).toBeNull();
    expect(repository.unsettledOperations).not.toHaveBeenCalled();
  });

  it('counts a probe that never answers as down after the timeout', async () => {
    vi.useFakeTimers();
    const { service } = build({ latestCheckpoint: () => new Promise<bigint>(() => {}) });
    const pending = service.platformReport();
    await vi.advanceTimersByTimeAsync(HEALTH_CHECK_TIMEOUT_MS);
    expect((await pending).checks.sui).toMatchObject({
      status: 'down',
      error: `No answer within ${HEALTH_CHECK_TIMEOUT_MS}ms`,
    });
  });

  it('reports a non-Error rejection as text', async () => {
    const { service } = build({ redisPing: () => Promise.reject('boom') });
    expect((await service.platformReport()).checks.redis.error).toBe('boom');
  });
});

describe('HealthService.publicReport', () => {
  it('drops error text from every check', async () => {
    const { service } = build({ ping: down('password authentication failed for user "octap"') });
    const report = await service.publicReport();
    expect(report.status).toBe('down');
    expect(report.checks.database).toEqual({ status: 'down', latencyMs: expect.any(Number) });
    expect(JSON.stringify(report)).not.toContain('password');
  });

  it('reuses one probe for the cache window, then probes again', async () => {
    vi.useFakeTimers();
    const { service, sui } = build();

    const [a, b] = await Promise.all([service.publicReport(), service.publicReport()]);
    expect(a).toBe(b);
    expect(sui.latestCheckpoint).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(PUBLIC_HEALTH_CACHE_MS - 1);
    await service.publicReport();
    expect(sui.latestCheckpoint).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(1);
    await service.publicReport();
    expect(sui.latestCheckpoint).toHaveBeenCalledTimes(2);
  });
});
