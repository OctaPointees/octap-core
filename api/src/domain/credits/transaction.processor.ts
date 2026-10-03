import { Injectable } from '@nestjs/common';
import { CreditsService } from './credits.service.js';
/** Scaffold: coordinate a single transaction job. No job handling is implemented. */
@Injectable()
export class TransactionProcessor {
  constructor(private readonly service: CreditsService) {}
}
