import {
  Controller,
  Post,
  Body,
  Param,
  BadRequestException,
  Header,
  HttpCode,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { IdentityService } from '#domain/identity/identity.service.js';
import type {
  GoogleLoginBodyDto,
  EnrollMemberBodyDto,
  ZkLoginNonceBodyDto,
  ZkLoginProofBodyDto,
  VerifyCustomerBodyDto,
} from '../dto/identity.dto.js';
import type { GoogleLoginResponse, EnrollMemberResponse, VerifyCustomerResponse } from '@octap/contracts';
import type { ZkLoginProofResult } from '#infra/clients/enoki/enoki.client.js';
import { Public } from '#infra/auth/public.decorator.js';
import { PublicRateLimitGuard } from '#infra/auth/public-rate-limit.guard.js';
import { Scopes } from '#infra/auth/scopes.decorator.js';
import { Tenant } from '#infra/auth/tenant.decorator.js';
import type { TenantContext } from '#infra/auth/tenant-context.js';

/** `body` is undefined when a request has no body, or one the JSON parser does not handle. */
function requireIdToken(body: { idToken?: unknown } | undefined): string {
  if (typeof body?.idToken !== 'string' || !body.idToken) {
    throw new BadRequestException('idToken is required');
  }
  return body.idToken;
}

/**
 * `@Public()`: opted out of the merchant API-key guard, because the caller here is the end customer
 * authenticating with their own Google identity, who never holds an API credential. The Google
 * id_token (validated by Enoki, not by us) is the proof of identity; `organizationId` is a path
 * parameter, not a secret. With no credential to limit, requests are limited per client IP.
 */
@Public()
@UseGuards(PublicRateLimitGuard)
@Controller('v1/identity')
export class IdentityController {
  constructor(private readonly identity: IdentityService) {}

  @Post('google-login')
  async googleLogin(@Body() body: GoogleLoginBodyDto): Promise<GoogleLoginResponse> {
    return this.identity.loginWithGoogle(requireIdToken(body));
  }

  @Post('organizations/:organizationId/enroll')
  async enroll(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() body: EnrollMemberBodyDto,
  ): Promise<EnrollMemberResponse> {
    return this.identity.enrollInOrganization({
      idToken: requireIdToken(body),
      organizationId,
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

/**
 * The merchant backend's side of identity, behind the API-key guard: the organization comes from
 * the credential, so one merchant can never ask about membership in another.
 */
@Controller('v1/identity')
export class CustomerVerificationController {
  constructor(private readonly identity: IdentityService) {}

  @Post('verify')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Scopes('read')
  async verify(@Tenant() tenant: TenantContext, @Body() body: VerifyCustomerBodyDto): Promise<VerifyCustomerResponse> {
    return this.identity.verifyCustomer(requireIdToken(body), tenant.organizationId);
  }
}
