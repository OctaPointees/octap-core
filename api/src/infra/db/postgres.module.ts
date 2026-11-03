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

const repositories = [
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
];

@Module({
  providers: [postgresClientProvider, drizzleProvider, OrganizationIdentityCipher, ...repositories],
  exports: [DRIZZLE_DB, POSTGRES_CLIENT, ...repositories],
})
export class PostgresModule {}
