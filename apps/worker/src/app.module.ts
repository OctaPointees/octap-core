import { Module } from '@nestjs/common';
import { ApplicationModule } from '@octap/core';
import { InfrastructureModule } from '@octap/infrastructure';
import { WorkersModule } from './workers.module.js';
@Module({ imports: [ApplicationModule, InfrastructureModule, WorkersModule] })
export class AppModule {}
