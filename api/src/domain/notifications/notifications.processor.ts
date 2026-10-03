import { Injectable } from '@nestjs/common';
import { NotificationsService } from './notifications.service.js';
/** Scaffold: coordinate a single notifications job. No job handling is implemented. */
@Injectable()
export class NotificationsProcessor {
  constructor(private readonly service: NotificationsService) {}
}
