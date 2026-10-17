import { Module } from '@nestjs/common';
import { drizzleProvider, postgresClientProvider, DRIZZLE_DB, POSTGRES_CLIENT } from './postgres.provider.js';
import { CreditsRepository } from './repositories/credits.repository.js';
import { RewardsRepository } from './repositories/rewards.repository.js';
import { ApiCredentialsRepository } from './repositories/api-credentials.repository.js';

const repositories = [
  CreditsRepository,
  RewardsRepository,
  ApiCredentialsRepository,
];

@Module({
  providers: [postgresClientProvider, drizzleProvider, ...repositories],
  exports: [DRIZZLE_DB, POSTGRES_CLIENT, ...repositories],
})
export class PostgresModule {}
