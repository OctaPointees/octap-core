import { Module } from '@nestjs/common';
import { BillingService } from './billing.service.js';
@Module({ providers: [BillingService], exports: [BillingService] })
export class BillingModule {}
