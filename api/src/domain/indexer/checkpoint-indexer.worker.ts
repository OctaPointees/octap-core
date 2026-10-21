import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { IndexerCursorMovedError } from '../../infra/db/repositories/indexer.repository.js';
import { CheckpointIndexerProcessor } from './checkpoint-indexer.processor.js';

const POLL_INTERVAL_MS = Number(process.env.INDEXER_POLL_INTERVAL_MS ?? 5000);
/** Caps one poll's catch-up so a long backlog can't hold the poll loop (and shutdown) indefinitely. */
const MAX_PAGES_PER_POLL = Number(process.env.INDEXER_MAX_PAGES_PER_POLL ?? 20);

/**
 * Owns the poll loop's lifecycle; `CheckpointIndexerProcessor` handles one page. Same shape as
 * `ChainSubmitWorker`: a plain interval with an in-flight guard, no queue library.
 */
@Injectable()
export class CheckpointIndexerWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CheckpointIndexerWorker.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private polling = false;

  constructor(private readonly processor: CheckpointIndexerProcessor) {}

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
      for (let pages = 0; pages < MAX_PAGES_PER_POLL && !this.stopped; pages++) {
        if (!(await this.processor.processNextPage())) {
          break;
        }
      }
    } catch (err: unknown) {
      if (err instanceof IndexerCursorMovedError) {
        this.logger.warn(err.message);
      } else {
        this.logger.error(`poll failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      this.polling = false;
    }
  }
}
