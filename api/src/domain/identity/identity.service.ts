import { Injectable, BadRequestException } from '@nestjs/common';
import { IdentityRepository } from '#infra/db/repositories/identity.repository.js';
import { EnokiClient, type EnokiNetwork, type ZkLoginProofResult } from '#infra/clients/enoki/enoki.client.js';

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
    if (!idToken) {
      throw new BadRequestException('idToken is required');
    }

    const resolved = await this.enoki.resolveZkLoginAddress(idToken);
    const existing = await this.repo.findEndUserBySuiAddress(resolved.address);
    if (existing) {
      return { endUserId: existing.id, suiAddress: resolved.address, isNewUser: false };
    }

    const created = await this.repo.createEndUser({ suiAddress: resolved.address });
    return { endUserId: created.id, suiAddress: resolved.address, isNewUser: true };
  }

  /** Enrolls an already-logged-in end user into one organization's loyalty program. Idempotent. */
  async enrollInOrganization(params: {
    endUserId: string;
    organizationId: string;
    externalMemberId?: string;
  }): Promise<{ organizationEndUserId: string; isNewEnrollment: boolean }> {
    const endUser = await this.repo.findEndUserById(params.endUserId);
    if (!endUser) {
      throw new BadRequestException(`No end user ${params.endUserId}`);
    }

    const existing = await this.repo.findEnrollment(params.organizationId, params.endUserId);
    if (existing) {
      return { organizationEndUserId: existing.id, isNewEnrollment: false };
    }

    const created = await this.repo.enroll(params);
    return { organizationEndUserId: created.id, isNewEnrollment: true };
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
