import { Module } from '@nestjs/common';
import { OperationsService } from './operations.service.js';
@Module({ providers: [OperationsService], exports: [OperationsService] })
export class OperationsModule {}
