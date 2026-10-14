import { Module } from '@nestjs/common';
import { drizzleProvider, postgresClientProvider, DRIZZLE_DB, POSTGRES_CLIENT } from './postgres.provider.js';
import { CreditsRepository } from './repositories/credits.repository.js';
import { RewardsRepository } from './repositories/rewards.repository.js';
import { OperationsRepository } from './repositories/operations.repository.js';
import { MembersRepository } from './repositories/members.repository.js';

const repositories = [
  CreditsRepository,
  RewardsRepository,
  OperationsRepository,
  MembersRepository,
];

@Module({
  providers: [postgresClientProvider, drizzleProvider, ...repositories],
  exports: [DRIZZLE_DB, POSTGRES_CLIENT, ...repositories],
})
export class PostgresModule {}
