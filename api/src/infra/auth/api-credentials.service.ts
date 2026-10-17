import { Injectable, NotFoundException } from '@nestjs/common';
import { ApiCredentialsRepository } from '../db/repositories/api-credentials.repository.js';
import { generateApiKey } from './api-key-hash.util.js';

export const DEFAULT_SCOPES = ['read', 'write'];

@Injectable()
export class ApiCredentialsService {
  constructor(private readonly repo: ApiCredentialsRepository) {}

  /** Returns the raw key exactly once; only its hash is ever persisted. */
  async issue(organizationId: string, name: string, scopes: string[] = DEFAULT_SCOPES) {
    const { raw, prefix, hash } = generateApiKey();
    const credential = await this.repo.create({
      organizationId,
      name,
      keyPrefix: prefix,
      keyHash: hash,
      scopes,
    });
    return { credential, rawKey: raw };
  }

  async list(organizationId: string) {
    return this.repo.listByOrganization(organizationId);
  }

  async revoke(organizationId: string, credentialId: string) {
    const existing = await this.assertOwned(organizationId, credentialId);
    if (existing.status === 'REVOKED') {
      return existing;
    }
    return this.repo.revoke(credentialId);
  }

  /** Revokes the old credential and issues a fresh one with the same name/scopes. */
  async rotate(organizationId: string, credentialId: string) {
    const existing = await this.assertOwned(organizationId, credentialId);
    await this.repo.revoke(existing.id);
    return this.issue(organizationId, existing.name, existing.scopes as string[]);
  }

  private async assertOwned(organizationId: string, credentialId: string) {
    const existing = await this.repo.findById(credentialId);
    if (!existing || existing.organizationId !== organizationId) {
      throw new NotFoundException(`API credential ${credentialId} was not found for this organization`);
    }
    return existing;
  }
}
