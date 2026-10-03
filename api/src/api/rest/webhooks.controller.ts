import { Controller } from '@nestjs/common';
import { WebhooksService } from '../../domain/webhooks/webhooks.service.js';
/** REST boundary for webhooks; no route methods or DTOs are implemented. */
@Controller()
export class WebhooksController {
  constructor(private readonly service: WebhooksService) {}
}
