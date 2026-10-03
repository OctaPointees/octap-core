import { Module } from '@nestjs/common';
import { StripeClient } from './stripe.client.js';
@Module({ providers: [StripeClient], exports: [StripeClient] })
export class StripeModule {}
