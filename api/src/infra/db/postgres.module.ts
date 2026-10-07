import { Module } from '@nestjs/common';
import { drizzleProvider, postgresClientProvider, DRIZZLE_DB, POSTGRES_CLIENT } from './postgres.provider.js';
import { OrganizationsRepository } from './repositories/organizations.repository.js';
import { MembersRepository } from './repositories/members.repository.js';
import { PoliciesRepository } from './repositories/policies.repository.js';
import { OperationsRepository } from './repositories/operations.repository.js';
import { OutboxRepository } from './repositories/outbox.repository.js';
import { CampaignApprovalsRepository } from './repositories/campaign-approvals.repository.js';
import { ProjectionsRepository } from './repositories/projections.repository.js';
import { WebhooksRepository } from './repositories/webhooks.repository.js';
import { BillingRepository } from './repositories/billing.repository.js';
import { IndexerCursorsRepository } from './repositories/indexer-cursors.repository.js';
import { CreditsRepository } from './repositories/credits.repository.js';
import { RewardsRepository } from './repositories/rewards.repository.js';

const repositories = [
  OrganizationsRepository,
  MembersRepository,
  PoliciesRepository,
  OperationsRepository,
  OutboxRepository,
  CampaignApprovalsRepository,
  ProjectionsRepository,
  WebhooksRepository,
  BillingRepository,
  IndexerCursorsRepository,
  CreditsRepository,
  RewardsRepository,
];

@Module({
  providers: [postgresClientProvider, drizzleProvider, ...repositories],
  exports: [DRIZZLE_DB, POSTGRES_CLIENT, ...repositories],
})
export class PostgresModule {}
