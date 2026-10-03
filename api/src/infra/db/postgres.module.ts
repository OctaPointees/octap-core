import { Module } from '@nestjs/common';
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
@Module({ providers: [OrganizationsRepository, MembersRepository, PoliciesRepository, OperationsRepository, OutboxRepository, CampaignApprovalsRepository, ProjectionsRepository, WebhooksRepository, BillingRepository, IndexerCursorsRepository], exports: [OrganizationsRepository, MembersRepository, PoliciesRepository, OperationsRepository, OutboxRepository, CampaignApprovalsRepository, ProjectionsRepository, WebhooksRepository, BillingRepository, IndexerCursorsRepository] })
export class PostgresModule {}
