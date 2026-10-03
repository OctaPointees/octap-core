import { Module } from '@nestjs/common';
import { MerchantWebhooksClient } from './merchant-webhooks.client.js';
@Module({ providers: [MerchantWebhooksClient], exports: [MerchantWebhooksClient] })
export class MerchantWebhooksModule {}
