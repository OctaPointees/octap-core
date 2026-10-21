import { Module } from '@nestjs/common';
import { EnokiClient } from './enoki.client.js';

@Module({
  providers: [EnokiClient],
  exports: [EnokiClient],
})
export class EnokiModule {}
