import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { DrizzleDb } from '../db/postgres.provider.js';
import { ApiCredentialsRepository, type ApiCredential } from '../db/repositories/api-credentials.repository.js';
import { generateApiKey } from './api-key-hash.util.js';

/** ACTIVE keys an organization may hold at once, script-issued ones included. */
export const MAX_ACTIVE_API_CREDENTIALS = 25;
export const API_CREDENTIAL_LIMIT_REACHED = 'API_CREDENTIAL_LIMIT_REACHED';

/**
 * Pass `tx` to join the caller's transaction, e.g. so the console's access check and the write
 * commit together. Without it, each call runs in its own transaction.
 * `authorize` runs on the credential once it is found and locked, before the write, so a caller with
 * its own rules (the console's per-role ones) checks the same row the write uses. It throws to refuse.
 */
export interface CredentialWriteOptions {
  tx?: DrizzleDb;
  authorize?: (credential: ApiCredential) => void;
}

@Injectable()
export class ApiCredentialsService {
  constructor(private readonly repo: ApiCredentialsRepository) {}

  /** Returns the raw key exactly once; only its hash is ever persisted. */
  async issue(organizationId: string, name: string, scopes: string[], tx?: DrizzleDb) {
    const { raw, prefix, hash } = generateApiKey();
    const credential = await this.repo.createWithinLimit(
      { organizationId, name, keyPrefix: prefix, keyHash: hash, scopes },
      MAX_ACTIVE_API_CREDENTIALS,
      tx,
    );
    if (!credential) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: API_CREDENTIAL_LIMIT_REACHED,
        message: `An organization can hold at most ${MAX_ACTIVE_API_CREDENTIALS} active API keys; revoke one first`,
      });
    }
    return { credential, rawKey: raw };
  }

  /** Revoking a key that is already revoked changes nothing. */
  async revoke(
    organizationId: string,
    credentialId: string,
    { tx, authorize }: CredentialWriteOptions = {},
  ): Promise<ApiCredential> {
    return this.repo.inTransaction(tx, async (db) => {
      const existing = await this.findOwned(db, organizationId, credentialId);
      authorize?.(existing);
      return existing.status === 'REVOKED' ? existing : this.repo.revoke(db, organizationId, credentialId);
    });
  }

  /** A revoked key is gone from the console, so it cannot be renamed either. */
  async rename(
    organizationId: string,
    credentialId: string,
    name: string,
    { tx, authorize }: CredentialWriteOptions = {},
  ): Promise<ApiCredential> {
    return this.repo.inTransaction(tx, async (db) => {
      const existing = await this.findOwned(db, organizationId, credentialId);
      if (existing.status !== 'ACTIVE') throw this.notFound(credentialId);
      authorize?.(existing);
      return this.repo.rename(db, organizationId, credentialId, name);
    });
  }

  /** The credential, locked for update, if it belongs to `organizationId`; a 404 otherwise. */
  private async findOwned(tx: DrizzleDb, organizationId: string, credentialId: string): Promise<ApiCredential> {
    const existing = await this.repo.findForUpdate(tx, organizationId, credentialId);
    if (!existing || existing.organizationId !== organizationId) throw this.notFound(credentialId);
    return existing;
  }

  private notFound(credentialId: string) {
    return new NotFoundException(`API credential ${credentialId} was not found for this organization`);
  }
}
