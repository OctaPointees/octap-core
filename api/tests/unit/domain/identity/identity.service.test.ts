import { describe, expect, it, vi } from 'vitest';
import { ConflictException, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { IdentityService } from '#domain/identity/identity.service.js';
import type { IdentityRepository } from '#infra/db/repositories/identity.repository.js';
import { EnokiTokenRejectedError, type EnokiClient } from '#infra/clients/enoki/enoki.client.js';
import { stub } from '../../../helpers/stub.js';

const enokiResolving = (address = '0xabc') =>
  stub<EnokiClient>({ resolveZkLoginAddress: async () => ({ address, publicKey: 'pk', salt: 'salt' }) });

describe('IdentityService.loginWithGoogle', () => {
  it('creates a new end user on first login', async () => {
    const createEndUser = vi.fn(async (params: { suiAddress: string }) => ({ id: 'end-user-1', ...params }));
    const resolveZkLoginAddress = vi.fn(async () => ({ address: '0xabc', publicKey: 'pk', salt: 'salt' }));
    const service = new IdentityService(
      stub<IdentityRepository>({ findEndUserBySuiAddress: async () => undefined, createEndUser }),
      stub<EnokiClient>({ resolveZkLoginAddress }),
    );

    const result = await service.loginWithGoogle('google-id-token');

    expect(resolveZkLoginAddress).toHaveBeenCalledWith('google-id-token');
    expect(createEndUser).toHaveBeenCalledWith({ suiAddress: '0xabc' });
    expect(result).toEqual({ endUserId: 'end-user-1', suiAddress: '0xabc', isNewUser: true });
  });

  it('returns the existing end user without creating a duplicate', async () => {
    const findEndUserBySuiAddress = vi.fn(async () => ({ id: 'end-user-1', suiAddress: '0xabc' }));
    const service = new IdentityService(
      stub<IdentityRepository>({ findEndUserBySuiAddress, createEndUser: () => expect.fail('should not create') }),
      enokiResolving(),
    );

    const result = await service.loginWithGoogle('google-id-token');

    expect(findEndUserBySuiAddress).toHaveBeenCalledWith('0xabc');
    expect(result).toEqual({ endUserId: 'end-user-1', suiAddress: '0xabc', isNewUser: false });
  });

  it('requires an idToken', async () => {
    const service = new IdentityService(stub<IdentityRepository>(), stub<EnokiClient>());
    await expect(service.loginWithGoogle('')).rejects.toThrow(/idToken is required/);
  });

  it('returns the winner when a concurrent login created the end user first', async () => {
    const findEndUserBySuiAddress = vi
      .fn<() => Promise<{ id: string } | undefined>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ id: 'winner' });
    const service = new IdentityService(
      stub<IdentityRepository>({ findEndUserBySuiAddress, createEndUser: async () => undefined }),
      enokiResolving(),
    );

    expect(await service.loginWithGoogle('jwt')).toEqual({
      endUserId: 'winner',
      suiAddress: '0xabc',
      isNewUser: false,
    });
  });
});

describe('IdentityService.enrollInOrganization', () => {
  const knownUser = { findEndUserBySuiAddress: async () => ({ id: 'end-user-1', status: 'ACTIVE' }) };
  const orgExists = { findOrganizationStatus: async () => 'ACTIVE' };
  const params = { idToken: 'jwt', organizationId: 'org-1' };

  it('enrolls the end user the token proves', async () => {
    const enroll = vi.fn(async (values: object) => ({ id: 'org-end-user-1', ...values }));
    const service = new IdentityService(
      stub<IdentityRepository>({ ...orgExists, ...knownUser, findEnrollment: async () => undefined, enroll }),
      enokiResolving(),
    );

    const result = await service.enrollInOrganization(params);

    expect(enroll).toHaveBeenCalledWith({ endUserId: 'end-user-1', organizationId: 'org-1' });
    expect(result).toEqual({ organizationEndUserId: 'org-end-user-1', endUserId: 'end-user-1', isNewEnrollment: true });
  });

  it('creates the end user when the token is the first this address has presented', async () => {
    const createEndUser = vi.fn(async () => ({ id: 'new-user', status: 'ACTIVE' }));
    const enroll = vi.fn(async () => ({ id: 'org-end-user-1' }));
    const service = new IdentityService(
      stub<IdentityRepository>({
        ...orgExists,
        findEndUserBySuiAddress: async () => undefined,
        createEndUser,
        findEnrollment: async () => undefined,
        enroll,
      }),
      enokiResolving(),
    );

    await service.enrollInOrganization(params);

    expect(createEndUser).toHaveBeenCalledWith({ suiAddress: '0xabc' });
    expect(enroll).toHaveBeenCalledWith(expect.objectContaining({ endUserId: 'new-user' }));
  });

  it('is idempotent for an existing enrollment', async () => {
    const service = new IdentityService(
      stub<IdentityRepository>({
        ...orgExists,
        ...knownUser,
        findEnrollment: async () => ({ id: 'org-end-user-1' }),
        enroll: () => expect.fail('should not enroll twice'),
      }),
      enokiResolving(),
    );

    expect(await service.enrollInOrganization(params)).toEqual({
      organizationEndUserId: 'org-end-user-1',
      endUserId: 'end-user-1',
      isNewEnrollment: false,
    });
  });

  it('returns the winner when a concurrent request enrolled first', async () => {
    const findEnrollment = vi
      .fn<() => Promise<{ id: string } | undefined>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ id: 'winner' });
    const service = new IdentityService(
      stub<IdentityRepository>({ ...orgExists, ...knownUser, findEnrollment, enroll: async () => undefined }),
      enokiResolving(),
    );

    expect(await service.enrollInOrganization(params)).toEqual({
      organizationEndUserId: 'winner',
      endUserId: 'end-user-1',
      isNewEnrollment: false,
    });
  });

  it('rejects a missing organization before spending an Enoki call', async () => {
    const resolveZkLoginAddress = vi.fn();
    const service = new IdentityService(
      stub<IdentityRepository>({ findOrganizationStatus: async () => undefined }),
      stub<EnokiClient>({ resolveZkLoginAddress }),
    );

    await expect(service.enrollInOrganization(params)).rejects.toBeInstanceOf(NotFoundException);
    expect(resolveZkLoginAddress).not.toHaveBeenCalled();
  });

  it('refuses an organization that is not active before spending an Enoki call', async () => {
    const resolveZkLoginAddress = vi.fn();
    const service = new IdentityService(
      stub<IdentityRepository>({ findOrganizationStatus: async () => 'SUSPENDED' }),
      stub<EnokiClient>({ resolveZkLoginAddress }),
    );

    await expect(service.enrollInOrganization(params)).rejects.toBeInstanceOf(ConflictException);
    expect(resolveZkLoginAddress).not.toHaveBeenCalled();
  });

  it('refuses a blocked customer', async () => {
    const service = new IdentityService(
      stub<IdentityRepository>({
        ...orgExists,
        findEndUserBySuiAddress: async () => ({ id: 'end-user-1', status: 'BLOCKED' }),
        enroll: () => expect.fail('should not enroll'),
      }),
      enokiResolving(),
    );

    await expect(service.enrollInOrganization(params)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('writes nothing for a token Enoki rejects', async () => {
    const service = new IdentityService(
      stub<IdentityRepository>({
        ...orgExists,
        createEndUser: () => expect.fail('should not create'),
        enroll: () => expect.fail('should not enroll'),
      }),
      stub<EnokiClient>({
        resolveZkLoginAddress: async () => {
          throw new EnokiTokenRejectedError('jwt_error');
        },
      }),
    );

    await expect(service.enrollInOrganization(params)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('IdentityService.verifyCustomer', () => {
  it('returns the member of the calling organization', async () => {
    const findEnrollment = vi.fn(async () => ({ id: 'member-1', status: 'ACTIVE' }));
    const service = new IdentityService(
      stub<IdentityRepository>({
        findEndUserBySuiAddress: async () => ({ id: 'end-user-1', status: 'ACTIVE' }),
        findEnrollment,
        createEndUser: () => expect.fail('should not write'),
        enroll: () => expect.fail('should not write'),
      }),
      enokiResolving(),
    );

    expect(await service.verifyCustomer('jwt', 'org-1')).toEqual({
      endUserId: 'end-user-1',
      suiAddress: '0xabc',
      memberId: 'member-1',
      active: true,
    });
    expect(findEnrollment).toHaveBeenCalledWith('org-1', 'end-user-1');
  });

  it('returns a null memberId before enrollment', async () => {
    const service = new IdentityService(
      stub<IdentityRepository>({
        findEndUserBySuiAddress: async () => ({ id: 'end-user-1', status: 'ACTIVE' }),
        findEnrollment: async () => undefined,
      }),
      enokiResolving(),
    );

    expect(await service.verifyCustomer('jwt', 'org-1')).toEqual({
      endUserId: 'end-user-1',
      suiAddress: '0xabc',
      memberId: null,
      active: false,
    });
  });

  it.each([
    ['BLOCKED', 'ACTIVE'],
    ['ACTIVE', 'SUSPENDED'],
  ])('reports an end user %s with a membership %s as not active', async (userStatus, memberStatus) => {
    const service = new IdentityService(
      stub<IdentityRepository>({
        findEndUserBySuiAddress: async () => ({ id: 'end-user-1', status: userStatus }),
        findEnrollment: async () => ({ id: 'member-1', status: memberStatus }),
      }),
      enokiResolving(),
    );

    expect(await service.verifyCustomer('jwt', 'org-1')).toMatchObject({ memberId: 'member-1', active: false });
  });

  it('creates nothing for an account that has never signed in', async () => {
    const service = new IdentityService(
      stub<IdentityRepository>({
        findEndUserBySuiAddress: async () => undefined,
        createEndUser: () => expect.fail('should not write'),
      }),
      enokiResolving(),
    );

    expect(await service.verifyCustomer('jwt', 'org-1')).toEqual({
      endUserId: null,
      suiAddress: '0xabc',
      memberId: null,
      active: false,
    });
  });

  it('turns a rejected token into a 401 and lets other Enoki failures stay 5xx', async () => {
    const rejecting = new IdentityService(
      stub<IdentityRepository>(),
      stub<EnokiClient>({
        resolveZkLoginAddress: async () => {
          throw new EnokiTokenRejectedError('jwt_error');
        },
      }),
    );
    await expect(rejecting.verifyCustomer('jwt', 'org-1')).rejects.toBeInstanceOf(UnauthorizedException);

    const outage = new Error('Enoki is down');
    const failing = new IdentityService(
      stub<IdentityRepository>(),
      stub<EnokiClient>({
        resolveZkLoginAddress: async () => {
          throw outage;
        },
      }),
    );
    await expect(failing.verifyCustomer('jwt', 'org-1')).rejects.toBe(outage);
  });
});

describe('IdentityService zkLogin passthroughs', () => {
  it('createZkLoginNonce forwards to Enoki', async () => {
    const createZkLoginNonce = vi.fn(async () => ({
      nonce: 'n',
      randomness: 'r',
      epoch: 1,
      maxEpoch: 3,
      estimatedExpiration: 0,
    }));
    const service = new IdentityService(stub<IdentityRepository>(), stub<EnokiClient>({ createZkLoginNonce }));

    const result = await service.createZkLoginNonce({ ephemeralPublicKey: 'epk', additionalEpochs: 2 });

    expect(createZkLoginNonce).toHaveBeenCalledWith({ ephemeralPublicKey: 'epk', additionalEpochs: 2 });
    expect(result.nonce).toBe('n');
  });

  it('createZkLoginNonce requires an ephemeral public key', async () => {
    const service = new IdentityService(stub<IdentityRepository>(), stub<EnokiClient>());
    await expect(service.createZkLoginNonce({ ephemeralPublicKey: '' })).rejects.toThrow(
      /ephemeralPublicKey is required/,
    );
  });

  it('createZkLoginProof turns a rejected token into a 401', async () => {
    const service = new IdentityService(
      stub<IdentityRepository>(),
      stub<EnokiClient>({
        createZkLoginProof: async () => {
          throw new EnokiTokenRejectedError('jwt_error');
        },
      }),
    );

    await expect(
      service.createZkLoginProof({ idToken: 'jwt', ephemeralPublicKey: 'epk', randomness: 'r', maxEpoch: 1 }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('createZkLoginProof renames idToken to Enoki’s jwt', async () => {
    const createZkLoginProof = vi.fn(async () => ({ proofPoints: {} }));
    const service = new IdentityService(stub<IdentityRepository>(), stub<EnokiClient>({ createZkLoginProof }));

    await service.createZkLoginProof({
      network: 'devnet',
      idToken: 'jwt',
      ephemeralPublicKey: 'epk',
      randomness: 'r',
      maxEpoch: 0,
    });

    expect(createZkLoginProof).toHaveBeenCalledWith({
      network: 'devnet',
      jwt: 'jwt',
      ephemeralPublicKey: 'epk',
      randomness: 'r',
      maxEpoch: 0,
    });
  });

  it.each([
    { idToken: '', ephemeralPublicKey: 'epk', randomness: 'r', maxEpoch: 1 },
    { idToken: 'jwt', ephemeralPublicKey: '', randomness: 'r', maxEpoch: 1 },
    { idToken: 'jwt', ephemeralPublicKey: 'epk', randomness: '', maxEpoch: 1 },
    { idToken: 'jwt', ephemeralPublicKey: 'epk', randomness: 'r', maxEpoch: undefined as unknown as number },
  ])('createZkLoginProof rejects a missing field: %o', async (params) => {
    const service = new IdentityService(stub<IdentityRepository>(), stub<EnokiClient>());
    await expect(service.createZkLoginProof(params)).rejects.toThrow(/are required/);
  });
});
