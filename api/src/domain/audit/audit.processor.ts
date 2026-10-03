import { Injectable } from '@nestjs/common';
import { AuditService } from './audit.service.js';
/** Scaffold: coordinate a single audit job. No job handling is implemented. */
@Injectable()
export class AuditProcessor {
  constructor(private readonly service: AuditService) {}
}
