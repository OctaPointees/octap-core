import { Module } from '@nestjs/common';
import { ApplicationModule } from '@octap/core';
/** Scaffold: REST adapter over the shared application services. */
@Module({ imports: [ApplicationModule] })
export class RestModule {}
