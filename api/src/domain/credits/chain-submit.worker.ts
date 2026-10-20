import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { OperationsRepository } from '../../infra/db/repositories/operations.repository.js';
import { ChainSubmitProcessor } from './chain-submit.processor.js';

const POLL_INTERVAL_MS = Number(process.env.CHAIN_SUBMIT_POLL_INTERVAL_MS ?? 3000);
const BATCH_SIZE = Number(process.env.CHAIN_SUBMIT_BATCH_SIZE ?? 5);
const COMMAND_TYPES = ['CREDIT_EARN_CHAIN_SUBMIT'];

/**
 * Owns the poll loop's lifecycle and concurrency; `ChainSubmitProcessor` carries one claimed
 * operation through the domain services. Polls `operations` directly (conditional-update claim,
 * see `OperationsRepository.claimNextPending`) rather than a queue library — `infra/queue` is for
 * whichever feature needs one first, per docs/implementation-guide.md, and a single demo worker
 * doesn't.
 */
@Injectable()
export class ChainSubmitWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChainSubmitWorker.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private polling = false;

  constructor(
    private readonly operationsRepo: OperationsRepository,
    private readonly processor: ChainSubmitProcessor,
  ) {}

  onModuleInit(): void {
    this.logger.log(`starting, polling every ${POLL_INTERVAL_MS}ms`);
    this.timer = setInterval(() => void this.pollOnce(), POLL_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
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
