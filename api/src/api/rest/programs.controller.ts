import { Controller } from '@nestjs/common';
import { ProgramsService } from '../../domain/programs/programs.service.js';
/** REST boundary for programs; no route methods or DTOs are implemented. */
@Controller()
export class ProgramsController {
  constructor(private readonly service: ProgramsService) {}
}
