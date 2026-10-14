import { BadRequestException, Body, Controller, Headers, Post } from '@nestjs/common';
import { MembersService } from '../../domain/members/members.service.js';
import type { EnsureMemberByPhoneBodyDto } from '../dto/members.dto.js';
import type { EnsureMemberByPhoneResponse } from '@octap/contracts';

@Controller('v1/members')
export class MembersController {
  constructor(private readonly membersService: MembersService) {}

  @Post('ensure-by-phone')
  async ensureByPhone(
    @Headers('x-organization-id') orgHeader: string | undefined,
    @Body() body: EnsureMemberByPhoneBodyDto,
  ): Promise<EnsureMemberByPhoneResponse> {
    const orgId = orgHeader || '00000000-0000-0000-0000-000000000001';
    if (!body.phoneNumber) {
      throw new BadRequestException('phoneNumber is required');
    }
    return this.membersService.ensureByPhone(orgId, body);
  }
}
