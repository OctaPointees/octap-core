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
import { ConsoleUsersRepository } from './repositories/console-users.repository.js';
import { ConsoleOperatorRepository } from './repositories/console-operator.repository.js';
import { ConsoleOrganizationsRepository } from './repositories/console-organizations.repository.js';
import { OrganizationIdentityCipher } from './organization-identity.cipher.js';

import { MembersRepository } from './repositories/members.repository.js';

import { GovernanceRepository } from './repositories/governance.repository.js';
import { OrganizationsRepository } from './repositories/organizations.repository.js';
import { OperationalHealthRepository } from './repositories/operational-health.repository.js';
import { SandboxRepository } from './repositories/sandbox.repository.js';
import { AuditRepository } from './repositories/audit.repository.js';
import { OrganizationEventsRepository } from './repositories/events.repository.js';
import { RequestLogsRepository } from './repositories/request-logs.repository.js';
import { EvidenceRepository } from './repositories/evidence.repository.js';
import { ProgramAnalyticsRepository } from './repositories/program-analytics.repository.js';
const repositories = [
  OrganizationsRepository,
  GovernanceRepository,
  MembersRepository,
  ConsoleOperatorRepository,
  ConsoleOrganizationsRepository,
  ConsoleUsersRepository,
  VoucherRefundPoliciesRepository,
  CreditsRepository,
  RewardsRepository,
  OperationsRepository,
  ApiCredentialsRepository,
  WebhooksRepository,
  IdentityRepository,
  IndexerRepository,
  ProgramsRepository,
  OperationalHealthRepository,
  OrganizationEventsRepository,
  RequestLogsRepository,
  SandboxRepository,
  AuditRepository,
  EvidenceRepository,
  ProgramAnalyticsRepository,
];

@Module({
  providers: [postgresClientProvider, drizzleProvider, OrganizationIdentityCipher, ...repositories],
  exports: [DRIZZLE_DB, POSTGRES_CLIENT, ...repositories],
})
export class PostgresModule {}
