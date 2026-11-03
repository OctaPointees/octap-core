import { Injectable, BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { VerifyCustomerResponse } from '@octap/contracts';
import { IdentityRepository } from '#infra/db/repositories/identity.repository.js';
import {
  EnokiClient,
  EnokiTokenRejectedError,
  type EnokiNetwork,
  type ZkLoginProofResult,
} from '#infra/clients/enoki/enoki.client.js';

@Injectable()
export class IdentityService {
  constructor(
    private readonly repo: IdentityRepository,
    private readonly enoki: EnokiClient,
  ) {}

  /**
   * Resolves a provider id_token (Google today) to a real zkLogin Sui address via Enoki — which
   * validates the token itself — and binds it to a global end-user identity. There is no
   * password and no session token issued here: a later sensitive action (redeem) is authorized
   * by the end user's own zkLogin signature on that specific transaction, not by anything this
   * call returns.
   */
  async loginWithGoogle(idToken: string): Promise<{ endUserId: string; suiAddress: string; isNewUser: boolean }> {
    const { endUser, suiAddress, isNewUser } = await this.findOrCreateEndUser(idToken);
    return { endUserId: endUser.id, suiAddress, isNewUser };
  }

  /**
   * Enrolls the end user the id_token proves into one organization's loyalty program. Idempotent,
   * including for concurrent requests. The caller never names the end user, so nobody can be
   * enrolled without their own token.
   */
  async enrollInOrganization(params: {
    idToken: string;
    organizationId: string;
    externalMemberId?: string;
  }): Promise<{ organizationEndUserId: string; endUserId: string; isNewEnrollment: boolean }> {
    // Checked first so a request for a missing organization spends no Enoki call.
    if (!(await this.repo.organizationExists(params.organizationId))) {
      throw new NotFoundException(`Organization ${params.organizationId} was not found`);
    }
    const { endUser } = await this.findOrCreateEndUser(params.idToken);

    const existing = await this.repo.findEnrollment(params.organizationId, endUser.id);
    if (existing) {
      return { organizationEndUserId: existing.id, endUserId: endUser.id, isNewEnrollment: false };
    }

    const created = await this.repo.enroll({
      organizationId: params.organizationId,
      endUserId: endUser.id,
      externalMemberId: params.externalMemberId,
    });
    if (created) {
      return { organizationEndUserId: created.id, endUserId: endUser.id, isNewEnrollment: true };
    }
    const winner = await this.repo.findEnrollment(params.organizationId, endUser.id);
    return { organizationEndUserId: winner!.id, endUserId: endUser.id, isNewEnrollment: false };
  }

  /**
   * The merchant backend's check of a token its frontend handed it, like Firebase Admin
   * `verifyIdToken`. Writes nothing: a customer who has not signed in yet has a null `endUserId`,
   * and one who has not joined this organization has a null `memberId`.
   */
  async verifyCustomer(idToken: string, organizationId: string): Promise<VerifyCustomerResponse> {
    const suiAddress = await this.resolveSuiAddress(idToken);
    const endUser = await this.repo.findEndUserBySuiAddress(suiAddress);
    if (!endUser) {
      return { endUserId: null, suiAddress, memberId: null };
    }
    const enrollment = await this.repo.findEnrollment(organizationId, endUser.id);
    return { endUserId: endUser.id, suiAddress, memberId: enrollment?.id ?? null };
  }

  private async resolveSuiAddress(idToken: string): Promise<string> {
    if (!idToken) {
      throw new BadRequestException('idToken is required');
    }
    try {
      return (await this.enoki.resolveZkLoginAddress(idToken)).address;
    } catch (err: unknown) {
      if (err instanceof EnokiTokenRejectedError) {
        throw new UnauthorizedException('The sign-in token is invalid or has expired; sign in again');
      }
      throw err;
    }
  }

  private async findOrCreateEndUser(idToken: string) {
    const suiAddress = await this.resolveSuiAddress(idToken);
    const existing = await this.repo.findEndUserBySuiAddress(suiAddress);
    if (existing) {
      return { endUser: existing, suiAddress, isNewUser: false };
    }
    const created = await this.repo.createEndUser({ suiAddress });
    if (created) {
      return { endUser: created, suiAddress, isNewUser: true };
    }
    const winner = await this.repo.findEndUserBySuiAddress(suiAddress);
    return { endUser: winner!, suiAddress, isNewUser: false };
  }

  /** Passthrough so `IdentityController` never imports a vendor client directly. */
  async createZkLoginNonce(params: { network?: EnokiNetwork; ephemeralPublicKey: string; additionalEpochs?: number }) {
    if (!params.ephemeralPublicKey) {
      throw new BadRequestException('ephemeralPublicKey is required');
    }
    return this.enoki.createZkLoginNonce(params);
  }

  /** Passthrough so `IdentityController` never imports a vendor client directly. */
  async createZkLoginProof(params: {
    network?: EnokiNetwork;
    idToken: string;
    ephemeralPublicKey: string;
    randomness: string;
    maxEpoch: number;
  }): Promise<ZkLoginProofResult> {
    if (!params.idToken || !params.ephemeralPublicKey || !params.randomness || params.maxEpoch === undefined) {
      throw new BadRequestException('idToken, ephemeralPublicKey, randomness, and maxEpoch are required');
    }
    return this.enoki.createZkLoginProof({
      network: params.network,
      jwt: params.idToken,
      ephemeralPublicKey: params.ephemeralPublicKey,
      randomness: params.randomness,
      maxEpoch: params.maxEpoch,
    });
  }
}
