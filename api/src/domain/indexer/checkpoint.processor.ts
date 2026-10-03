import { Injectable } from '@nestjs/common';
import { IndexerService } from './indexer.service.js';
/** Scaffold: coordinate a single checkpoint job. No job handling is implemented. */
@Injectable()
export class CheckpointProcessor {
  constructor(private readonly service: IndexerService) {}
}
