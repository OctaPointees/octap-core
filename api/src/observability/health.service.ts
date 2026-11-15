import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '#infra/cache/redis.provider.js';
import { CUSTOMER_REDEEM_COMMAND_TYPES } from '#infra/db/repositories/credits.repository.js';
import { VOUCHER_USE_COMMAND_TYPE } from '#infra/db/repositories/rewards.repository.js';
import { SuiTransactionBuilderClient } from '#infra/clients/sui/sui-transaction-builder.client.js';
import { OperationalHealthRepository } from '#infra/db/repositories/operational-health.repository.js';

/** One dependency probe may take this long before it counts as down; a hung probe must not hang `/health`. */
export const HEALTH_CHECK_TIMEOUT_MS = 3_000;
/** How long the public report is reused: `/health` is unauthenticated and each probe reaches the Sui RPC. */
export const PUBLIC_HEALTH_CACHE_MS = 5_000;

/**
 * Commands that sit PENDING until the end customer signs (POS redeem, voucher claim and use): no
 * worker owes them anything yet, and an abandoned signature waits for the reconciler's window, so
 * their PENDING age is not worker lag. Once UNKNOWN they are the reconciler's, and count again.
 */
const AWAITING_CUSTOMER_COMMAND_TYPES: readonly string[] = [...CUSTOMER_REDEEM_COMMAND_TYPES, VOUCHER_USE_COMMAND_TYPE];

export interface DependencyCheck {
  status: 'up' | 'down';
  latencyMs: number;
  /** Why it is down. Only in the platform report: the public one does not describe internals. */
  error?: string;
}

/**
 * `down`: the database or Redis is unreachable, so this process cannot serve requests (every
 * authenticated route needs both) — `/health` answers 503. `degraded`: only the Sui RPC is
 * unreachable; reads and accepted commands still work and chain work queues up — still 200, so a
 * load balancer does not pull every instance over a flaky public RPC.
 */
export type HealthStatus = 'ok' | 'degraded' | 'down';

export interface HealthReport {
  status: HealthStatus;
  checkedAt: string;
  checks: HealthChecks;
}

/** Spelled out rather than a `Record<…>`: the OpenAPI schema generator names a `Record` after its source path. */
export interface HealthChecks {
  database: DependencyCheck;
  redis: DependencyCheck;
  sui: DependencyCheck;
}

export interface OperationLag {
  commandType: string;
  status: string;
  count: number;
  oldestAgeSeconds: number;
  /** PENDING and waiting on the customer's signature, not on a worker: left out of `oldestWorkerOwedAgeSeconds`. */
  awaitingCustomer: boolean;
}

export interface IndexerLag {
  streamName: string;
  lastCheckpoint: string | null;
  caughtUpCheckpoint: string | null;
  /** The chain's latest checkpoint from this same report's Sui probe; null when the probe failed. */
  chainCheckpoint: string | null;
  /** How far the stream's furthest-known position trails the chain; null when either side is unknown. */
  checkpointsBehind: string | null;
  /** Since the indexer last wrote this stream's cursor row (a page or a caught-up poll). */
  sinceUpdateSeconds: number;
}

export interface WorkerLag {
  operations: {
    /**
     * Age of the oldest PENDING, PROCESSING or UNKNOWN command a worker owes something to (every
     * group without `awaitingCustomer`) — the figure to alert on. Null when there is none.
     */
    oldestWorkerOwedAgeSeconds: number | null;
    byCommandType: OperationLag[];
  };
  webhookDeliveries: {
    pending: number;
    due: number;
    oldestDueAgeSeconds: number | null;
    deadLettered: number;
  };
  indexer: IndexerLag[];
}

export interface PlatformHealthReport extends HealthReport {
  /** Null when the database is down: every lag figure is read from it. */
  workerLag: WorkerLag | null;
}

interface Probe<T> {
  check: DependencyCheck;
  value?: T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function probe<T>(run: () => Promise<T>, timeoutMs: number): Promise<Probe<T>> {
  const startedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`No answer within ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    const value = await Promise.race([run(), timeout]);
    return { check: { status: 'up', latencyMs: Date.now() - startedAt }, value };
  } catch (error) {
    return { check: { status: 'down', latencyMs: Date.now() - startedAt, error: errorMessage(error) } };
  } finally {
    clearTimeout(timer);
  }
}

function overallStatus(checks: HealthChecks): HealthStatus {
  if (checks.database.status === 'down' || checks.redis.status === 'down') return 'down';
  return checks.sui.status === 'down' ? 'degraded' : 'ok';
}

/** The furthest checkpoint the stream is known to have covered: its newest projected event, or a caught-up poll. */
function streamPosition(lastCheckpoint: string | null, caughtUpCheckpoint: string | null): bigint | null {
  const known = [lastCheckpoint, caughtUpCheckpoint].filter((c): c is string => c !== null).map((c) => BigInt(c));
  if (known.length === 0) return null;
  return known.reduce((a, b) => (a > b ? a : b));
}

/**
 * Dependency reachability (database, Redis, Sui RPC) and worker lag, read from the HTTP process.
 * Lag comes from what the workers leave in the database — the command outbox, webhook deliveries,
 * indexer cursors — so it is visible even when no worker is running, which is exactly when it grows.
 */
@Injectable()
export class HealthService {
  private cachedPublic?: { at: number; report: Promise<HealthReport> };

  constructor(
    private readonly repository: OperationalHealthRepository,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly sui: SuiTransactionBuilderClient,
  ) {}

  /**
   * For unauthenticated `/health`: statuses and latencies only, no error text. Reused for
   * `PUBLIC_HEALTH_CACHE_MS`, and concurrent callers share one in-flight probe, so polling it
   * cannot multiply load on the database or the Sui RPC.
   */
  async publicReport(): Promise<HealthReport> {
    const now = Date.now();
    if (!this.cachedPublic || now - this.cachedPublic.at >= PUBLIC_HEALTH_CACHE_MS) {
      this.cachedPublic = {
        at: now,
        report: this.probeDependencies().then(({ report }) => ({
          ...report,
          checks: {
            database: { status: report.checks.database.status, latencyMs: report.checks.database.latencyMs },
            redis: { status: report.checks.redis.status, latencyMs: report.checks.redis.latencyMs },
            sui: { status: report.checks.sui.status, latencyMs: report.checks.sui.latencyMs },
          },
        })),
      };
    }
    return this.cachedPublic.report;
  }

  /** For platform operators: every probe's error, plus worker lag. Never cached. */
  async platformReport(): Promise<PlatformHealthReport> {
    const { report, chainCheckpoint } = await this.probeDependencies();
    if (report.checks.database.status === 'down') return { ...report, workerLag: null };
    return { ...report, workerLag: await this.workerLag(chainCheckpoint) };
  }

  private async probeDependencies(): Promise<{ report: HealthReport; chainCheckpoint: bigint | null }> {
    const [database, redis, sui] = await Promise.all([
      probe(() => this.repository.ping(), HEALTH_CHECK_TIMEOUT_MS),
      probe(() => this.redis.ping(), HEALTH_CHECK_TIMEOUT_MS),
      probe(() => this.sui.latestCheckpoint(), HEALTH_CHECK_TIMEOUT_MS),
    ]);
    const checks = { database: database.check, redis: redis.check, sui: sui.check };
    return {
      report: { status: overallStatus(checks), checkedAt: new Date().toISOString(), checks },
      chainCheckpoint: sui.value ?? null,
    };
  }

  private async workerLag(chainCheckpoint: bigint | null): Promise<WorkerLag> {
    const [operations, webhooks, streams] = await Promise.all([
      this.repository.unsettledOperations(),
      this.repository.webhookBacklog(),
      this.repository.indexerStreams(),
    ]);
    const byCommandType = operations.map((group) => ({
      ...group,
      awaitingCustomer: group.status === 'PENDING' && AWAITING_CUSTOMER_COMMAND_TYPES.includes(group.commandType),
    }));
    const workerOwed = byCommandType.filter((group) => !group.awaitingCustomer).map((g) => g.oldestAgeSeconds);
    return {
      operations: {
        oldestWorkerOwedAgeSeconds: workerOwed.length === 0 ? null : Math.max(...workerOwed),
        byCommandType,
      },
      webhookDeliveries: {
        pending: webhooks?.pending ?? 0,
        due: webhooks?.due ?? 0,
        oldestDueAgeSeconds: webhooks?.oldestDueAgeSeconds ?? null,
        deadLettered: webhooks?.deadLettered ?? 0,
      },
      indexer: streams.map((stream) => {
        const position = streamPosition(stream.lastCheckpoint, stream.caughtUpCheckpoint);
        const behind =
          position === null || chainCheckpoint === null
            ? null
            : (chainCheckpoint > position ? chainCheckpoint - position : 0n).toString();
        return {
          streamName: stream.streamName,
          lastCheckpoint: stream.lastCheckpoint,
          caughtUpCheckpoint: stream.caughtUpCheckpoint,
          chainCheckpoint: chainCheckpoint?.toString() ?? null,
          checkpointsBehind: behind,
          sinceUpdateSeconds: stream.sinceUpdateSeconds,
        };
      }),
    };
  }
}
