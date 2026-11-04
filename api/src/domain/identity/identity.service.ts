import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { VerifyCustomerResponse } from '@octap/contracts';
import { EnrollmentRefusedError, IdentityRepository } from '#infra/db/repositories/identity.repository.js';
import {
  EnokiClient,
  EnokiTokenRejectedError,
  type EnokiNetwork,
  type ZkLoginProofResult,
} from '#infra/clients/enoki/enoki.client.js';

const organizationNotActive = () => new ConflictException('This organization is not accepting members');
const customerNotActive = () => new ForbiddenException('This customer account is not active');

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
  }): Promise<{ organizationEndUserId: string; endUserId: string; isNewEnrollment: boolean }> {
    // Checked first so a request for an unusable organization spends no Enoki call. `repo.enroll`
    // checks again under locks, because this can change while Enoki resolves the token.
    const status = await this.repo.findOrganizationStatus(params.organizationId);
    if (!status) {
      throw new NotFoundException(`Organization ${params.organizationId} was not found`);
    }
    if (status !== 'ACTIVE') {
      throw organizationNotActive();
    }

    const { endUser } = await this.findOrCreateEndUser(params.idToken);
    if (endUser.status !== 'ACTIVE') {
      throw customerNotActive();
    }

    const existing = await this.repo.findEnrollment(params.organizationId, endUser.id);
    if (existing) {
      return { organizationEndUserId: existing.id, endUserId: endUser.id, isNewEnrollment: false };
    }

    let created: Awaited<ReturnType<IdentityRepository['enroll']>>;
    try {
      created = await this.repo.enroll({ organizationId: params.organizationId, endUserId: endUser.id });
    } catch (err: unknown) {
      if (err instanceof EnrollmentRefusedError) {
        throw err.reason === 'ORGANIZATION_NOT_ACTIVE' ? organizationNotActive() : customerNotActive();
      }
      throw err;
    }
    if (created) {
      return { organizationEndUserId: created.id, endUserId: endUser.id, isNewEnrollment: true };
    }
    const winner = await this.repo.findEnrollment(params.organizationId, endUser.id);
    return { organizationEndUserId: winner!.id, endUserId: endUser.id, isNewEnrollment: false };
  }

  /**
   * The merchant backend's check of a token its frontend handed it, like Firebase Admin
   * `verifyIdToken`. Writes nothing: a customer who has not signed in yet has a null `endUserId`,
   * and one who has not joined this organization has a null `memberId`. `active` matches what
   * reward operations will accept for this member.
   */
  async verifyCustomer(idToken: string, organizationId: string): Promise<VerifyCustomerResponse> {
    const suiAddress = await this.resolveSuiAddress(idToken);
    const endUser = await this.repo.findEndUserBySuiAddress(suiAddress);
    if (!endUser) {
      return { endUserId: null, suiAddress, memberId: null, active: false };
    }
    const enrollment = await this.repo.findEnrollment(organizationId, endUser.id);
    return {
      endUserId: endUser.id,
      suiAddress,
      memberId: enrollment?.id ?? null,
      active: endUser.status === 'ACTIVE' && enrollment?.status === 'ACTIVE',
    };
  }

  private async resolveSuiAddress(idToken: string): Promise<string> {
    if (!idToken) {
      throw new BadRequestException('idToken is required');
    }
    const { address } = await this.refusingBadTokens(() => this.enoki.resolveZkLoginAddress(idToken));
    return address;
  }

  private async refusingBadTokens<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
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
    return this.refusingBadTokens(() =>
      this.enoki.createZkLoginProof({
        network: params.network,
        jwt: params.idToken,
        ephemeralPublicKey: params.ephemeralPublicKey,
        randomness: params.randomness,
        maxEpoch: params.maxEpoch,
      }),
    );
  }
}
