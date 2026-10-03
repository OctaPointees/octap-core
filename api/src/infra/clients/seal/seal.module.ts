import { Module } from '@nestjs/common';
import { SealClient } from './seal.client.js';
@Module({ providers: [SealClient], exports: [SealClient] })
export class SealModule {}
