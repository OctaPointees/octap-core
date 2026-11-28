import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { CampaignDetailDto, CampaignDto, CampaignVoucherActionResponse } from '@octap/contracts';
import { ConsoleCampaignsService } from '#domain/rewards/campaigns.service.js';
import { Public } from '#infra/auth/public.decorator.js';
import { ConsoleAccessGuard, type ConsoleRequest } from './console-access.guard.js';
import type { ActivateVoucherBatchBodyDto, CreateCampaignBodyDto } from '../dto/console.dto.js';

/**
 * Campaigns from the console (OCT-340): the Owner and a Business Developer list, read and create
 * them (as DRAFT); only the Owner activates (approves), pauses, resumes, ends or archives one. The
 * `vouchers/*` routes act on every voucher of the campaign, with the batch routes' rules.
 * See `ConsoleCampaignsService`.
 */
@Public()
@UseGuards(ConsoleAccessGuard)
@Controller('v1/console/organizations/:organizationId/campaigns')
export class ConsoleCampaignsController {
  constructor(private readonly campaigns: ConsoleCampaignsService) {}

  @Post()
  @Header('Cache-Control', 'no-store')
  create(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Body() body: CreateCampaignBodyDto,
  ): Promise<CampaignDto> {
    return this.campaigns.create(req.consoleIdentity.user.id, orgId, body);
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  list(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Query('includeArchived') includeArchived?: 'true' | 'false',
  ): Promise<CampaignDto[]> {
    return this.campaigns.list(req.consoleIdentity.user.id, orgId, includeArchived);
  }

  @Get(':campaignId')
  @Header('Cache-Control', 'no-store')
  detail(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
  ): Promise<CampaignDetailDto> {
    return this.campaigns.detail(req.consoleIdentity.user.id, orgId, campaignId);
  }

  @Post(':campaignId/activate')
  @Header('Cache-Control', 'no-store')
  activate(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
  ): Promise<CampaignDto> {
    return this.campaigns.transition(req.consoleIdentity.user.id, orgId, campaignId, 'activate');
  }

  @Post(':campaignId/pause')
  @Header('Cache-Control', 'no-store')
  pause(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
  ): Promise<CampaignDto> {
    return this.campaigns.transition(req.consoleIdentity.user.id, orgId, campaignId, 'pause');
  }

  @Post(':campaignId/resume')
  @Header('Cache-Control', 'no-store')
  resume(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
  ): Promise<CampaignDto> {
    return this.campaigns.transition(req.consoleIdentity.user.id, orgId, campaignId, 'resume');
  }

  @Post(':campaignId/end')
  @Header('Cache-Control', 'no-store')
  end(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
  ): Promise<CampaignDto> {
    return this.campaigns.transition(req.consoleIdentity.user.id, orgId, campaignId, 'end');
  }

  @Post(':campaignId/archive')
  @Header('Cache-Control', 'no-store')
  archive(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
  ): Promise<CampaignDto> {
    return this.campaigns.transition(req.consoleIdentity.user.id, orgId, campaignId, 'archive');
  }

  @Post(':campaignId/vouchers/activate')
  @Header('Cache-Control', 'no-store')
  activateVouchers(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
    @Body() body: ActivateVoucherBatchBodyDto,
  ): Promise<CampaignVoucherActionResponse> {
    return this.campaigns.activateVouchers(req.consoleIdentity.user.id, orgId, campaignId, body);
  }

  @Post(':campaignId/vouchers/pause')
  @Header('Cache-Control', 'no-store')
  pauseVouchers(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
  ): Promise<CampaignVoucherActionResponse> {
    return this.campaigns.setVouchersPaused(req.consoleIdentity.user.id, orgId, campaignId, true);
  }

  @Post(':campaignId/vouchers/resume')
  @Header('Cache-Control', 'no-store')
  resumeVouchers(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
  ): Promise<CampaignVoucherActionResponse> {
    return this.campaigns.setVouchersPaused(req.consoleIdentity.user.id, orgId, campaignId, false);
  }

  @Post(':campaignId/vouchers/archive')
  @Header('Cache-Control', 'no-store')
  archiveVouchers(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) orgId: string,
    @Param('campaignId', ParseUUIDPipe) campaignId: string,
  ): Promise<CampaignVoucherActionResponse> {
    return this.campaigns.archiveVouchers(req.consoleIdentity.user.id, orgId, campaignId);
  }
}
