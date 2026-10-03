import { Module } from '@nestjs/common';
import { SuiClient } from './sui.client.js';
@Module({ providers: [SuiClient], exports: [SuiClient] })
export class SuiModule {}
