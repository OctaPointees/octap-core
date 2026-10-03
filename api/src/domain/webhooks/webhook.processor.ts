import { Injectable } from '@nestjs/common';
import { WebhooksService } from './webhooks.service.js';
/** Scaffold: coordinate a single webhook job. No job handling is implemented. */
@Injectable()
export class WebhookProcessor {
  constructor(private readonly service: WebhooksService) {}
}
