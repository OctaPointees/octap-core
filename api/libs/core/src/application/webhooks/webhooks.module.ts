import { Module } from '@nestjs/common';
import { WebhooksService } from './webhooks.service.js';
@Module({ providers: [WebhooksService], exports: [WebhooksService] })
export class WebhooksModule {}
