import { Module } from '@nestjs/common';
import { PostgresModule } from '#infra/db/postgres.module.js';
import { AuditLogService } from './audit-log.service.js';

/** The audit log's read side (OCT-333). Writes happen in each change's own transaction (`recordAudit`). */
@Module({ imports: [PostgresModule], providers: [AuditLogService], exports: [AuditLogService] })
export class AuditModule {}
