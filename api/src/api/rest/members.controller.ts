import { Controller } from '@nestjs/common';
import { MembersService } from '../../domain/members/members.service.js';
/** REST boundary for members; no route methods or DTOs are implemented. */
@Controller()
export class MembersController {
  constructor(private readonly service: MembersService) {}
}
