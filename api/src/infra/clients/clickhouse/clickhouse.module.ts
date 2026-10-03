import { Module } from '@nestjs/common';
import { ClickhouseClient } from './clickhouse.client.js';
@Module({ providers: [ClickhouseClient], exports: [ClickhouseClient] })
export class ClickhouseModule {}
