import { Injectable } from '@nestjs/common';
import { ProjectionProcessor } from './projection.processor.js';
/** Scaffold: projection job lifecycle. No consumer, timer, retry or execution. */
@Injectable()
export class ProjectionWorker {
  constructor(private readonly processor: ProjectionProcessor) {}
}
