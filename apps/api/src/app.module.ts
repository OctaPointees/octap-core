import { Module } from '@nestjs/common';
import { ApplicationModule } from '@octap/core';
import { InfrastructureModule } from '@octap/infrastructure';
import { RestModule } from './transports/rest/rest.module.js';
import { GrpcModule } from './transports/grpc/grpc.module.js';
@Module({ imports: [ApplicationModule, InfrastructureModule, RestModule, GrpcModule] })
export class AppModule {}
