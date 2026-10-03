import { Controller } from '@nestjs/common';
import { AuditService } from '../../domain/audit/audit.service.js';
/** REST boundary for audit; no route methods or DTOs are implemented. */
@Controller()
export class AuditController {
  constructor(private readonly service: AuditService) {}
}
