import { Controller, Get, Header, Param, ParseUUIDPipe, Query, Req, UseGuards } from '@nestjs/common';
import type { BalanceReconciliation, LoyaltyTransactionPage, ProgramEvidence } from '@octap/contracts';
import { LedgerEvidenceService } from '#domain/credits/ledger-evidence.service.js';
import { Public } from '#infra/auth/public.decorator.js';
import { ConsoleAccessGuard, type ConsoleRequest } from './console-access.guard.js';
import type { OrganizationTransactionQueryDto } from '../dto/credits.dto.js';

/**
 * The on-chain evidence behind the console's ledger views (OCT-334, for OCT-328), for the Owner and
 * Business Developers. The same reads as an API key's `GET /v1/credits/transactions`, `/program`
 * and `/members/:memberId/reconciliation`.
 */
@Public()
@UseGuards(ConsoleAccessGuard)
@Controller('v1/console/organizations/:organizationId')
export class ConsoleLedgerController {
  constructor(private readonly evidence: LedgerEvidenceService) {}

  @Get('transactions')
  @Header('Cache-Control', 'no-store')
  transactions(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Query() query: OrganizationTransactionQueryDto,
  ): Promise<LoyaltyTransactionPage> {
    return this.evidence.organizationTransactionsAsMember(req.consoleIdentity.user.id, orgId, { ...query });
  }

  @Get('program')
  @Header('Cache-Control', 'no-store')
  program(@Req() req: ConsoleRequest, @Param('organizationId', ParseUUIDPipe) orgId: string): Promise<ProgramEvidence> {
    return this.evidence.programAsMember(req.consoleIdentity.user.id, orgId);
  }

  @Get('members/:memberId/reconciliation')
  @Header('Cache-Control', 'no-store')
  reconciliation(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
  ): Promise<BalanceReconciliation> {
    return this.evidence.reconcileAsMember(req.consoleIdentity.user.id, orgId, memberId);
  }
}
