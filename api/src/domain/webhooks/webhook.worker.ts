import { Injectable } from '@nestjs/common';
import { WebhookProcessor } from './webhook.processor.js';
/** Scaffold: webhook job lifecycle. No consumer, timer, retry or execution. */
@Injectable()
export class WebhookWorker {
  constructor(private readonly processor: WebhookProcessor) {}
}
