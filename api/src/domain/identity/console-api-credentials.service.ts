import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { ConsoleCredential, CreatedConsoleCredential } from '@octap/contracts';
import { ApiCredentialsService } from '#infra/auth/api-credentials.service.js';
import type { ApiCredential } from '#infra/db/repositories/api-credentials.repository.js';
import {
  ConsoleAccessError,
  ConsoleOrganizationsRepository,
} from '#infra/db/repositories/console-organizations.repository.js';

type DeveloperRole = 'OWNER' | 'BUSINESS_DEVELOPER';

/**
 * An organization's API keys, managed from the console by its Owner or a Business Developer.
 * A key's scopes are what it can do, whoever holds it: only the Owner creates or manages a key with
 * more than `read`. Console keys are never `admin`; that stays with the seed script.
 */
@Injectable()
export class ConsoleApiCredentialsService {
  constructor(
    private readonly organizations: ConsoleOrganizationsRepository,
    private readonly apiCredentials: ApiCredentialsService,
  ) {}

  private async run<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof ConsoleAccessError)
        throw new ForbiddenException('You do not have permission for this organization or operation');
      throw error;
    }
  }

  list(userId: string, orgId: string): Promise<ConsoleCredential[]> {
    return this.run(async () => (await this.organizations.credentials(userId, orgId)).map(toConsoleCredential));
  }

  /** `read` is the default; only the Owner may ask for `write`. */
  issue(userId: string, orgId: string, input: Record<string, unknown>): Promise<CreatedConsoleCredential> {
    if (!input || typeof input !== 'object' || Object.keys(input).some((key) => key !== 'name' && key !== 'scope'))
      throw new BadRequestException('Only name and scope can be set on an API key');
    const name = credentialName(input.name);
    if (input.scope !== undefined && input.scope !== 'read' && input.scope !== 'write')
      throw new BadRequestException('scope must be read or write');
    const scopes = input.scope === 'write' ? ['read', 'write'] : ['read'];
    return this.run(async () => {
      const { credential, rawKey } = await this.organizations.withDeveloperAccess(userId, orgId, (tx, role) => {
        if (role !== 'OWNER' && scopes.includes('write'))
          throw new ForbiddenException('Only the Owner can create a write key; a Business Developer creates read keys');
        return this.apiCredentials.issue(orgId, name, scopes, tx);
      });
      return { ...toConsoleCredential(credential), rawKey };
    });
  }

  rename(
    userId: string,
    orgId: string,
    credentialId: string,
    input: Record<string, unknown>,
  ): Promise<ConsoleCredential> {
    if (!input || typeof input !== 'object' || Object.keys(input).some((key) => key !== 'name'))
      throw new BadRequestException('Only the name of an API key can be changed');
    const name = credentialName(input.name);
    return this.run(async () =>
      toConsoleCredential(
        await this.organizations.withDeveloperAccess(userId, orgId, (tx, role) =>
          this.apiCredentials.rename(orgId, credentialId, name, { tx, authorize: keyAuthority(role) }),
        ),
      ),
    );
  }

  /** The row stays, as REVOKED; the key fails authentication from the next request on. */
  revoke(userId: string, orgId: string, credentialId: string) {
    return this.run(async () => {
      await this.organizations.withDeveloperAccess(userId, orgId, (tx, role) =>
        this.apiCredentials.revoke(orgId, credentialId, { tx, authorize: keyAuthority(role) }),
      );
      return { revoked: true as const };
    });
  }
}

/** The Owner manages every key; a Business Developer only read-only ones, never the Owner's write keys. */
function keyAuthority(role: DeveloperRole) {
  return (credential: Pick<ApiCredential, 'scopes'>) => {
    if (role === 'OWNER') return;
    if ((credential.scopes as string[]).some((scope) => scope !== 'read'))
      throw new ForbiddenException('Only the Owner can revoke or rename a key with more than read access');
  };
}

function credentialName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100)
    throw new BadRequestException('name must be 1–100 characters');
  return value.trim();
}

/** Whitelists the fields the console may see: never the key hash. */
function toConsoleCredential(
  row: Pick<ApiCredential, 'id' | 'name' | 'keyPrefix' | 'scopes' | 'status' | 'createdAt' | 'lastUsedAt'>,
): ConsoleCredential {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    scopes: row.scopes as string[],
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  };
}
