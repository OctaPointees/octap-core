import { Module } from '@nestjs/common';
import { IndexerService } from './indexer.service.js';
@Module({ providers: [IndexerService], exports: [IndexerService] })
export class IndexerModule {}
