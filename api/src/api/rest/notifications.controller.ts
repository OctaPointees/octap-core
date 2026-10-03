import { Controller } from '@nestjs/common';
import { NotificationsService } from '../../domain/notifications/notifications.service.js';
/** REST boundary for notifications; no route methods or DTOs are implemented. */
@Controller()
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}
}
