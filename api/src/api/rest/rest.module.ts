import { Module } from '@nestjs/common';
import { DomainModule } from '#domain/domain.module.js';
import { AuthModule } from '#infra/auth/auth.module.js';
import { ObservabilityModule } from '#observability/observability.module.js';
import { CreditsController } from './credits.controller.js';
import { RewardsController } from './rewards.controller.js';
import { WebhooksController } from './webhooks.controller.js';
import { CustomerVerificationController, IdentityController } from './identity.controller.js';
import { ConsoleIdentityController } from './console-identity.controller.js';
import {
  ConsoleOrganizationsController,
  PlatformOrganizationRequestsController,
  PlatformOrganizationOwnersController,
} from './console-organizations.controller.js';
import { ConsoleAccessGuard } from './console-access.guard.js';
import { ConsoleMcpTokenController, McpOAuthController } from './mcp-oauth.controller.js';
import { MembersController } from './members.controller.js';
import { ConsoleRewardsController } from './console-rewards.controller.js';
import { ConsoleVoucherBatchesController } from './console-voucher-batches.controller.js';
import { VoucherBatchesController } from './voucher-batches.controller.js';
import { ConsoleRefundPolicyController } from './console-refund-policy.controller.js';
import { ConsoleWebhooksController } from './console-webhooks.controller.js';
import { ConsoleEventsController } from './console-events.controller.js';
import { ConsoleApiCredentialsController } from './console-api-credentials.controller.js';
import { ConsoleChangeRequestsController, PlatformChangeRequestsController } from './administration.controller.js';
import { PlatformOrganizationsController, OrganizationResolutionController } from './organizations.controller.js';
import { ConsoleIssuanceBudgetController, PlatformIssuanceBudgetController } from './issuance-budget.controller.js';
import { HealthController, PlatformHealthController } from './health.controller.js';
import { ConsoleLedgerController } from './console-ledger.controller.js';
import { ConsoleAuditLogController } from './console-audit-log.controller.js';
import { ConsoleEvidenceController } from './console-evidence.controller.js';
import { ConsoleAssistantController } from './console-assistant.controller.js';
import { ConsoleRequestLogsController } from './console-request-logs.controller.js';
import {
  ConsoleLicenseController,
  ConsoleLicensePlansController,
  LicenseController,
  PlatformLicensePlansController,
  PlatformOrganizationLicenseController,
} from './licenses.controller.js';
import { PostgresModule } from '#infra/db/postgres.module.js';
import { ConsoleAnalyticsController } from './console-analytics.controller.js';
@Module({
  imports: [DomainModule, AuthModule, ObservabilityModule, PostgresModule],
  providers: [ConsoleAccessGuard],
  controllers: [
    HealthController,
    PlatformHealthController,
    McpOAuthController,
    ConsoleMcpTokenController,
    ConsoleAssistantController,
    ConsoleLicenseController,
    ConsoleLicensePlansController,
    LicenseController,
    PlatformLicensePlansController,
    PlatformOrganizationLicenseController,
    PlatformOrganizationsController,
    OrganizationResolutionController,
    ConsoleIssuanceBudgetController,
    PlatformIssuanceBudgetController,
    ConsoleChangeRequestsController,
    PlatformChangeRequestsController,
    MembersController,
    ConsoleLedgerController,
    ConsoleAuditLogController,
    ConsoleEvidenceController,
    ConsoleRewardsController,
    ConsoleVoucherBatchesController,
    ConsoleRefundPolicyController,
    ConsoleWebhooksController,
    ConsoleEventsController,
    ConsoleApiCredentialsController,
    ConsoleRequestLogsController,
    ConsoleAnalyticsController,
    CreditsController,
    RewardsController,
    VoucherBatchesController,
    WebhooksController,
    IdentityController,
    CustomerVerificationController,
    ConsoleIdentityController,
    ConsoleOrganizationsController,
    PlatformOrganizationRequestsController,
    PlatformOrganizationOwnersController,
  ],
})
export class RestModule {}
