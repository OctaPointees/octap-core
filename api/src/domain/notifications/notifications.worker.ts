import { Injectable } from '@nestjs/common';
import { NotificationsProcessor } from './notifications.processor.js';
/** Scaffold: notifications job lifecycle. No consumer, timer, retry or execution. */
@Injectable()
export class NotificationsWorker {
  constructor(private readonly processor: NotificationsProcessor) {}
}
