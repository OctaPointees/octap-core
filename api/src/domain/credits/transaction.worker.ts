import { Injectable } from '@nestjs/common';
import { TransactionProcessor } from './transaction.processor.js';
/** Scaffold: transaction job lifecycle. No consumer, timer, retry or execution. */
@Injectable()
export class TransactionWorker {
  constructor(private readonly processor: TransactionProcessor) {}
}
