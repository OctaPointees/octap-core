import { Module } from '@nestjs/common';
import { AuditService } from './audit.service.js';
import { AuditVerifierService } from './audit-verifier.service.js';
@Module({ providers: [AuditService, AuditVerifierService], exports: [AuditService, AuditVerifierService] })
export class AuditModule {}
