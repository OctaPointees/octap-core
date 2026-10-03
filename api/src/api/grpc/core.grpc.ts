import { Injectable } from '@nestjs/common';
import { CreditsService } from '../../domain/credits/credits.service.js';
import { OperationsService } from '../../domain/operations/operations.service.js';
/** Core RPC adapter slot. No RPC methods or listener are registered. */
@Injectable()
export class CoreGrpcAdapter {
  constructor(private readonly credits: CreditsService, private readonly operations: OperationsService) {}
}
