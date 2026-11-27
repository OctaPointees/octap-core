import { Controller, Get, Header, Param, ParseUUIDPipe, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { EvidenceBundle, EvidencePeriodDetail, EvidencePeriodPage, EvidenceRecomputation } from '@octap/contracts';
import { EvidenceService } from '#domain/audit/evidence.service.js';
import { Public } from '#infra/auth/public.decorator.js';
import { ConsoleAccessGuard, type ConsoleRequest } from './console-access.guard.js';
import type { EvidenceQueryDto } from '../dto/console.dto.js';

interface HeaderResponse {
  setHeader(name: string, value: string): void;
}

/**
 * The organization's sealed audit evidence (OCT-77): the Console's Audit page. Owner only. Read-only:
 * the worker seals periods, nobody creates or edits one here.
 */
@Public()
@UseGuards(ConsoleAccessGuard)
@Controller('v1/console/organizations/:organizationId/evidence')
export class ConsoleEvidenceController {
  constructor(private readonly evidence: EvidenceService) {}

  /** The sealed periods, newest first, with how far sealing has reached. */
  @Get()
  @Header('Cache-Control', 'no-store')
  list(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Query() query: EvidenceQueryDto,
  ): Promise<EvidencePeriodPage> {
    return this.evidence.list(req.consoleIdentity.user.id, orgId, query);
  }

  /** One period: its hashes, its seal on Sui and its copy on Walrus. */
  @Get(':periodId')
  @Header('Cache-Control', 'no-store')
  detail(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('periodId', ParseUUIDPipe) periodId: string,
  ): Promise<EvidencePeriodDetail> {
    return this.evidence.detail(req.consoleIdentity.user.id, orgId, periodId);
  }

  /**
   * For the Verify button: the manifest as sealed and the period recomputed from the database now.
   * The browser checks both against the seal on Sui (`verifyRecomputation` in `@octap/verify`).
   */
  @Get(':periodId/verification')
  @Header('Cache-Control', 'no-store')
  verification(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('periodId', ParseUUIDPipe) periodId: string,
  ): Promise<EvidenceRecomputation> {
    return this.evidence.recompute(req.consoleIdentity.user.id, orgId, periodId);
  }

  /** The period's bundle, as a file to hand to an auditor (`npx @octap/verify <file>`). */
  @Get(':periodId/bundle')
  @Header('Cache-Control', 'no-store')
  async bundle(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('periodId', ParseUUIDPipe) periodId: string,
    @Res({ passthrough: true }) res: HeaderResponse,
  ): Promise<EvidenceBundle> {
    const bundle = await this.evidence.bundle(req.consoleIdentity.user.id, orgId, periodId);
    const day = bundle.manifest.periodStart.replace(/[:]/g, '-');
    res.setHeader('Content-Disposition', `attachment; filename="octap-evidence-${day}.json"`);
    return bundle;
  }
}
