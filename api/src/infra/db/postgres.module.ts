import { Module } from '@nestjs/common';
import { drizzleProvider, postgresClientProvider, DRIZZLE_DB, POSTGRES_CLIENT } from './postgres.provider.js';
import { CreditsRepository } from './repositories/credits.repository.js';
import { RewardsRepository } from './repositories/rewards.repository.js';
import { OperationsRepository } from './repositories/operations.repository.js';
import { ApiCredentialsRepository } from './repositories/api-credentials.repository.js';
import { WebhooksRepository } from './repositories/webhooks.repository.js';
import { IdentityRepository } from './repositories/identity.repository.js';
import { IndexerRepository } from './repositories/indexer.repository.js';
import { ProgramsRepository } from './repositories/programs.repository.js';

import { VoucherRefundPoliciesRepository } from './repositories/voucher-refund-policies.repository.js';

const repositories = [
  VoucherRefundPoliciesRepository,
  CreditsRepository,
  RewardsRepository,
  OperationsRepository,
  ApiCredentialsRepository,
  WebhooksRepository,
  IdentityRepository,
  IndexerRepository,
  ProgramsRepository,
];

@Module({
  providers: [postgresClientProvider, drizzleProvider, ...repositories],
  exports: [DRIZZLE_DB, POSTGRES_CLIENT, ...repositories],
})
export class PostgresModule {}
