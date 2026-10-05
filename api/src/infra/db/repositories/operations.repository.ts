import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';

/**
 * Persistence adapter for operations and durable command tracking.
 */
@Injectable()
export class OperationsRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}
}
