import { Controller } from '@nestjs/common';
import { OperationsService } from '../../domain/operations/operations.service.js';
/** REST boundary for operations; no route methods or DTOs are implemented. */
@Controller()
export class OperationsController {
  constructor(private readonly service: OperationsService) {}
}
