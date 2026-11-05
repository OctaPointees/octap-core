import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { OperationsRepository } from '#infra/db/repositories/operations.repository.js';
import { ChainSubmitProcessor } from './chain-submit.processor.js';
import { ChainOutcomeReconciler, EARN_COMMAND_TYPE, REVERSAL_COMMAND_TYPE } from './chain-outcome.reconciler.js';
import { VOUCHER_GRANT_COMMAND_TYPE, VOUCHER_PUBLISH_COMMAND_TYPE } from '#infra/db/repositories/rewards.repository.js';

const POLL_INTERVAL_MS = Number(process.env.CHAIN_SUBMIT_POLL_INTERVAL_MS ?? 3000);
const BATCH_SIZE = Number(process.env.CHAIN_SUBMIT_BATCH_SIZE ?? 5);
const COMMAND_TYPES = [
  EARN_COMMAND_TYPE,
  REVERSAL_COMMAND_TYPE,
  VOUCHER_PUBLISH_COMMAND_TYPE,
  VOUCHER_GRANT_COMMAND_TYPE,
];
const RECONCILE_INTERVAL_MS = Number(process.env.CHAIN_OUTCOME_RECONCILE_INTERVAL_MS ?? 60_000);
/** A healthy chain submit resolves in seconds; stuck this long means the worker that claimed it died. */
const STALE_PROCESSING_MS = Number(process.env.CHAIN_SUBMIT_STALE_PROCESSING_MS ?? 5 * 60 * 1000);

/**
 * Owns the poll loop's lifecycle and concurrency; `ChainSubmitProcessor` carries one claimed
 * operation through the domain services. Polls `operations` directly (conditional-update claim,
 * see `OperationsRepository.claimNextPending`) rather than a queue library — `infra/queue` is for
 * whichever feature needs one first, per docs/implementation-guide.md, and a single worker instance
 * doesn't.
 */
@Injectable()
export class ChainSubmitWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChainSubmitWorker.name);
  private timer?: NodeJS.Timeout;
  private reconcileTimer?: NodeJS.Timeout;
  private stopped = false;
  private polling = false;
  private reconciling = false;

  constructor(
    private readonly operationsRepo: OperationsRepository,
    private readonly processor: ChainSubmitProcessor,
    private readonly reconciler: ChainOutcomeReconciler,
  ) {}

  onModuleInit(): void {
    // Fire-and-forget: a crashed previous instance's stuck rows get surfaced once the DB is
    // reachable, but a slow/unavailable DB at the exact moment of startup must not delay or
    // crash this process starting its own poll loop (and must not make constructing the Nest
    // dependency graph — see scripts/check-bootstrap.mjs — require a live database).
    void this.recoverStaleOperations();

    this.logger.log(`starting, polling every ${POLL_INTERVAL_MS}ms`);
    this.timer = setInterval(() => void this.pollOnce(), POLL_INTERVAL_MS);
    this.reconcileTimer = setInterval(() => void this.reconcileOnce(), RECONCILE_INTERVAL_MS);
  }

  private async recoverStaleOperations(): Promise<void> {
    try {
      const recovered = await this.operationsRepo.recoverStaleProcessing(COMMAND_TYPES, STALE_PROCESSING_MS);
      if (recovered.length > 0) {
        this.logger.warn(
          `recovered ${recovered.length} operation(s) stuck in PROCESSING (likely a prior crash) -> UNKNOWN: ${recovered.map((o) => o.id).join(', ')}`,
        );
      }
    } catch (err: unknown) {
      this.logger.error(
        `failed to recover stale PROCESSING operations at startup: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
    }
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
    }
  }

  /** Settles outcome-unknown commands by digest; see `ChainOutcomeReconciler`. */
  private async reconcileOnce(): Promise<void> {
    if (this.reconciling || this.stopped) {
      return;
    }
    this.reconciling = true;
    try {
      await this.reconciler.reconcileOnce();
    } catch (err: unknown) {
      this.logger.error(`reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.reconciling = false;
    }
  }

  private async pollOnce(): Promise<void> {
    if (this.polling || this.stopped) {
      return;
    }
    this.polling = true;
    try {
      const claimed = await this.operationsRepo.claimNextPending(COMMAND_TYPES, BATCH_SIZE);
      for (const operation of claimed) {
        await this.processor.process(operation);
      }
    } catch (err: unknown) {
      this.logger.error(`poll failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.polling = false;
    }
  }
}
