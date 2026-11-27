import { Module } from '@nestjs/common';
import { PostgresModule } from '#infra/db/postgres.module.js';
import { AuditLogService } from './audit-log.service.js';
import { EvidenceBuilder } from './evidence-builder.service.js';
import { EvidenceService } from './evidence.service.js';

/**
 * The audit log's read side (OCT-333), and the Owner's sealed evidence (OCT-77). Writes to the log
 * happen in each change's own transaction (`recordAudit`); sealing runs in the worker
 * (`EvidenceSealProcessor`, registered in `worker.module.ts`).
 */
@Module({
  imports: [PostgresModule],
  providers: [AuditLogService, EvidenceBuilder, EvidenceService],
  exports: [AuditLogService, EvidenceBuilder, EvidenceService],
})
export class AuditModule {}
