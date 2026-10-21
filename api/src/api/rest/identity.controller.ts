import { Controller, Post, Body, Param, BadRequestException } from '@nestjs/common';
import { IdentityService } from '../../domain/identity/identity.service.js';
import type {
  GoogleLoginBodyDto,
  EnrollMemberBodyDto,
  ZkLoginNonceBodyDto,
  ZkLoginProofBodyDto,
} from '../dto/identity.dto.js';
import type { GoogleLoginResponse, EnrollMemberResponse } from '@octap/contracts';
import type { ZkLoginProofResult } from '../../infra/clients/enoki/enoki.client.js';

/**
 * Deliberately not gated by `@Tenant()`/`@Scopes()` (the merchant API-key guard): the caller here
 * is the end customer authenticating with their own Google identity, who never holds an API
 * credential. The Google id_token (validated by Enoki, not by us) is the proof of identity;
 * `organizationId` is a path parameter, not a secret.
 */
@Controller('v1/identity')
export class IdentityController {
  constructor(private readonly identity: IdentityService) {}

  @Post('google-login')
  async googleLogin(@Body() body: GoogleLoginBodyDto): Promise<GoogleLoginResponse> {
    if (!body.idToken) {
      throw new BadRequestException('idToken is required');
    }
    return this.identity.loginWithGoogle(body.idToken);
  }

  @Post('organizations/:organizationId/enroll')
  async enroll(
    @Param('organizationId') organizationId: string,
    @Body() body: EnrollMemberBodyDto,
  ): Promise<EnrollMemberResponse> {
    if (!body.endUserId) {
      throw new BadRequestException('endUserId is required');
    }
    return this.identity.enrollInOrganization({
      endUserId: body.endUserId,
      organizationId,
      externalMemberId: body.externalMemberId,
    });
  }

  @Post('zklogin/nonce')
  async createNonce(@Body() body: ZkLoginNonceBodyDto) {
    return this.identity.createZkLoginNonce(body);
  }

  @Post('zklogin/proof')
  async createProof(@Body() body: ZkLoginProofBodyDto): Promise<ZkLoginProofResult> {
    return this.identity.createZkLoginProof(body);
  }
}
