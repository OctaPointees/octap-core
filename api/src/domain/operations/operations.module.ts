import { Module } from '@nestjs/common';
import { OperationsService } from './operations.service.js';
import { OperationRecoveryService } from './operation-recovery.service.js';
import { OutboxService } from './outbox.service.js';
@Module({ providers: [OperationsService, OperationRecoveryService, OutboxService], exports: [OperationsService, OperationRecoveryService, OutboxService] })
export class OperationsModule {}
