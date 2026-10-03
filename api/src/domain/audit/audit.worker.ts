import { Injectable } from '@nestjs/common';
import { AuditProcessor } from './audit.processor.js';
/** Scaffold: audit job lifecycle. No consumer, timer, retry or execution. */
@Injectable()
export class AuditWorker {
  constructor(private readonly processor: AuditProcessor) {}
}
