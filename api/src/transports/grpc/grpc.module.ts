import { Module } from '@nestjs/common';
import { ApplicationModule } from '@octap/core';
/** Scaffold: GRPC adapter over the shared application services. */
@Module({ imports: [ApplicationModule] })
export class GrpcModule {}
