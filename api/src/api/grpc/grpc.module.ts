import { Module } from '@nestjs/common';
import { DomainModule } from '../../domain/domain.module.js';
import { CoreGrpcAdapter } from './core.grpc.js';
@Module({ imports: [DomainModule], providers: [CoreGrpcAdapter] })
export class GrpcModule {}
