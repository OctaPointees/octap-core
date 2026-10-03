import { Controller } from '@nestjs/common';
import { OrganizationsService } from '../../domain/organizations/organizations.service.js';
/** REST boundary for organizations; no route methods or DTOs are implemented. */
@Controller()
export class OrganizationsController {
  constructor(private readonly service: OrganizationsService) {}
}
