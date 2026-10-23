import { describe, expect, it, vi } from 'vitest';
import { IdentityService } from '../../../../src/domain/identity/identity.service.js';
import type { IdentityRepository } from '../../../../src/infra/db/repositories/identity.repository.js';
import type { EnokiClient } from '../../../../src/infra/clients/enoki/enoki.client.js';
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
});

describe('IdentityService.enrollInOrganization', () => {
  it('creates a new enrollment for a known end user', async () => {
    const enroll = vi.fn(async (params: object) => ({ id: 'org-end-user-1', ...params }));
    const service = new IdentityService(
      stub<IdentityRepository>({
        findEndUserById: async (id: string) => ({ id, suiAddress: '0xabc' }),
        findEnrollment: async () => undefined,
        enroll,
      }),
      stub<EnokiClient>(),
    );

    const result = await service.enrollInOrganization({ endUserId: 'end-user-1', organizationId: 'org-1', externalMemberId: 'ext-1' });

    expect(enroll).toHaveBeenCalledWith({ endUserId: 'end-user-1', organizationId: 'org-1', externalMemberId: 'ext-1' });
    expect(result).toEqual({ organizationEndUserId: 'org-end-user-1', isNewEnrollment: true });
  });

  it('is idempotent for an existing enrollment', async () => {
    const service = new IdentityService(
      stub<IdentityRepository>({
        findEndUserById: async (id: string) => ({ id, suiAddress: '0xabc' }),
        findEnrollment: async () => ({ id: 'org-end-user-1' }),
        enroll: () => expect.fail('should not enroll twice'),
      }),
      stub<EnokiClient>(),
    );

    expect(await service.enrollInOrganization({ endUserId: 'end-user-1', organizationId: 'org-1' })).toEqual({
      organizationEndUserId: 'org-end-user-1',
      isNewEnrollment: false,
    });
  });

  it('rejects an unknown end user', async () => {
    const service = new IdentityService(stub<IdentityRepository>({ findEndUserById: async () => undefined }), stub<EnokiClient>());
    await expect(service.enrollInOrganization({ endUserId: 'ghost', organizationId: 'org-1' })).rejects.toThrow(/No end user ghost/);
  });
});

describe('IdentityService zkLogin passthroughs', () => {
  it('createZkLoginNonce forwards to Enoki', async () => {
    const createZkLoginNonce = vi.fn(async () => ({ nonce: 'n', randomness: 'r', epoch: 1, maxEpoch: 3, estimatedExpiration: 0 }));
    const service = new IdentityService(stub<IdentityRepository>(), stub<EnokiClient>({ createZkLoginNonce }));

    const result = await service.createZkLoginNonce({ ephemeralPublicKey: 'epk', additionalEpochs: 2 });

    expect(createZkLoginNonce).toHaveBeenCalledWith({ ephemeralPublicKey: 'epk', additionalEpochs: 2 });
    expect(result.nonce).toBe('n');
  });

  it('createZkLoginNonce requires an ephemeral public key', async () => {
    const service = new IdentityService(stub<IdentityRepository>(), stub<EnokiClient>());
    await expect(service.createZkLoginNonce({ ephemeralPublicKey: '' })).rejects.toThrow(/ephemeralPublicKey is required/);
  });

  it('createZkLoginProof renames idToken to Enoki’s jwt', async () => {
    const createZkLoginProof = vi.fn(async () => ({ proofPoints: {} }));
    const service = new IdentityService(stub<IdentityRepository>(), stub<EnokiClient>({ createZkLoginProof }));

    await service.createZkLoginProof({ network: 'devnet', idToken: 'jwt', ephemeralPublicKey: 'epk', randomness: 'r', maxEpoch: 0 });

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
