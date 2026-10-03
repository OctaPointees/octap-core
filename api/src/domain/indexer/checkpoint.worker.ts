import { Injectable } from '@nestjs/common';
import { CheckpointProcessor } from './checkpoint.processor.js';
/** Scaffold: checkpoint job lifecycle. No consumer, timer, retry or execution. */
@Injectable()
export class CheckpointWorker {
  constructor(private readonly processor: CheckpointProcessor) {}
}
