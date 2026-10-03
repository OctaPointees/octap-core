import { Module } from '@nestjs/common';
import { WalrusClient } from './walrus.client.js';
@Module({ providers: [WalrusClient], exports: [WalrusClient] })
export class WalrusModule {}
