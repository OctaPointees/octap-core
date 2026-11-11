import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type {
  ConsoleCredential,
  ConsoleIdentity,
  CreatedConsoleCredential,
  OrganizationApplicationInput,
} from '@octap/contracts';
import { ApiCredentialsService } from '#infra/auth/api-credentials.service.js';
import type { ApiCredential } from '#infra/db/repositories/api-credentials.repository.js';
import {
  ConsoleAccessError,
  ConsoleConflictError,
  ConsoleGoneError,
  ConsoleNotFoundError,
  ConsoleOrganizationsRepository,
  ConsoleValidationError,
} from '#infra/db/repositories/console-organizations.repository.js';

@Injectable()
export class ConsoleOrganizationsService {
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
      if (error instanceof ConsoleConflictError) throw new ConflictException(error.message);
      if (error instanceof ConsoleValidationError) throw new BadRequestException(error.message);
      if (error instanceof ConsoleGoneError)
        throw new GoneException('Invitation has expired or is no longer available');
      if (error instanceof ConsoleNotFoundError) throw new NotFoundException('Request or invitation not found');
      throw error;
    }
  }
  private profileInput(input: Record<string, unknown>) {
    const text = (key: string, required = false) => {
      const value = input?.[key];
      if (value === undefined && !required) return undefined;
      if (typeof value !== 'string' || value.trim().length < (required ? 2 : 0) || value.length > 160)
        throw new BadRequestException(`Invalid ${key}`);
      return value.trim();
    };
    const nationalId = input?.nationalId;
    if (nationalId !== undefined && (typeof nationalId !== 'string' || !/^\d{12}$/.test(nationalId)))
      throw new BadRequestException('CCCD must contain exactly 12 digits');
    return {
      name: text('name', true)!,
      legalName: text('legalName'),
      taxId: text('taxId'),
      representativeName: text('representativeName'),
      nationalId: nationalId as string | undefined,
    };
  }
  apply(userId: string, input: Record<string, unknown>, adminActorId?: string) {
    const profile = this.profileInput(input);
    const organizationType = input?.organizationType;
    if (organizationType !== 'INDIVIDUAL_HOUSEHOLD' && organizationType !== 'COMPANY')
      throw new BadRequestException('Choose Individual / Household business or Company');
    if (
      organizationType === 'INDIVIDUAL_HOUSEHOLD' &&
      (!profile.representativeName || profile.representativeName.length < 2)
    )
      throw new BadRequestException('A representative full name is required');
    if (
      organizationType === 'COMPANY' &&
      (!profile.legalName ||
        profile.legalName.length < 2 ||
        !profile.taxId ||
        !/^[A-Za-z0-9][A-Za-z0-9-]{1,30}[A-Za-z0-9]$/.test(profile.taxId))
    )
      throw new BadRequestException('A company legal name and business registration / tax number are required');
    if (organizationType === 'COMPANY' && profile.nationalId !== undefined)
      throw new BadRequestException('CCCD belongs to the Individual / Household business setup');
    const slug = input?.slug;
    if (
      typeof slug !== 'string' ||
      !/^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/.test(slug) ||
      ['admin', 'auth', 'api', 'www', 'docs', 'console', 'support'].includes(slug)
    )
      throw new BadRequestException('Use a unique slug of 3–48 lowercase letters, numbers or hyphens');
    return this.run(async () => ({
      id: await this.organizations.apply(
        userId,
        {
          ...profile,
          slug,
          organizationType,
        } satisfies OrganizationApplicationInput,
        adminActorId,
      ),
    }));
  }
  applications(userId: string, platform = false) {
    return this.run(() => this.organizations.applications(userId, platform));
  }
  decide(userId: string, id: string, approve: boolean, reason?: unknown) {
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 1000)
      throw new BadRequestException('A review reason is required (up to 1000 characters)');
    return this.run(() =>
      this.organizations.decide(userId, id, approve, typeof reason === 'string' ? reason.trim() : undefined),
    );
  }
  organization(userId: string, orgId: string) {
    return this.run(() => this.organizations.organization(userId, orgId));
  }
  profile(userId: string, orgId: string, input: Record<string, unknown>) {
    if (
      input?.organizationType !== undefined &&
      input.organizationType !== 'INDIVIDUAL_HOUSEHOLD' &&
      input.organizationType !== 'COMPANY'
    )
      throw new BadRequestException('Invalid organization type');
    const profile = this.profileInput(input);
    return this.run(async () => {
      await this.organizations.profile(userId, orgId, {
        ...profile,
        ...(input.organizationType
          ? { organizationType: input.organizationType as 'INDIVIDUAL_HOUSEHOLD' | 'COMPANY' }
          : {}),
      });
      return { updated: true };
    });
  }
  staff(userId: string, orgId: string) {
    return this.run(() => this.organizations.staff(userId, orgId));
  }
  staffAccess(userId: string, orgId: string, targetId: string, input: Record<string, unknown>) {
    if (
      (input?.status !== 'ACTIVE' && input?.status !== 'SUSPENDED') ||
      Object.keys(input).some((key) => key !== 'status')
    )
      throw new BadRequestException('Only ACTIVE or SUSPENDED Developer access can be changed');
    return this.run(async () => {
      await this.organizations.staffAccess(userId, orgId, targetId, input.status as 'ACTIVE' | 'SUSPENDED');
      return { updated: true };
    });
  }
  bootstrapOwner(userId: string, orgId: string, targetId: string) {
    return this.run(async () => {
      await this.organizations.bootstrapOwner(userId, orgId, targetId);
      return { created: true };
    });
  }
  credentials(userId: string, orgId: string): Promise<ConsoleCredential[]> {
    return this.run(async () => (await this.organizations.credentials(userId, orgId)).map(toConsoleCredential));
  }
  /**
   * Owner or Business Developer; only the Owner creates `write` keys, and `read` is the default.
   * Console keys are never `admin`: that stays with the seed script.
   */
  issueCredential(userId: string, orgId: string, input: Record<string, unknown>): Promise<CreatedConsoleCredential> {
    if (!input || typeof input !== 'object' || Object.keys(input).some((key) => key !== 'name' && key !== 'scope'))
      throw new BadRequestException('Only name and scope can be set on an API key');
    const name = credentialName(input.name);
    if (input.scope !== undefined && input.scope !== 'read' && input.scope !== 'write')
      throw new BadRequestException('scope must be read or write');
    const scopes = input.scope === 'write' ? ['read', 'write'] : ['read'];
    return this.run(async () => {
      const { credential, rawKey } = await this.organizations.withStaffAccess(userId, orgId, (tx, role) => {
        if (role !== 'OWNER' && scopes.includes('write'))
          throw new ForbiddenException('Only the Owner can create a write key; a Business Developer creates read keys');
        return this.apiCredentials.issue(orgId, name, scopes, tx);
      });
      return { ...toConsoleCredential(credential), rawKey };
    });
  }
  renameCredential(
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
        await this.organizations.withStaffAccess(userId, orgId, async (tx, role) => {
          requireKeyAuthority(role, await this.apiCredentials.findOwned(tx, orgId, credentialId));
          return this.apiCredentials.rename(orgId, credentialId, name, tx);
        }),
      ),
    );
  }
  /** The row stays, as REVOKED; the key fails authentication from the next request on. */
  revokeCredential(userId: string, orgId: string, credentialId: string) {
    return this.run(async () => {
      await this.organizations.withStaffAccess(userId, orgId, async (tx, role) => {
        requireKeyAuthority(role, await this.apiCredentials.findOwned(tx, orgId, credentialId));
        return this.apiCredentials.revoke(orgId, credentialId, tx);
      });
      return { revoked: true as const };
    });
  }
  invite(userId: string, orgId: string, input: Record<string, unknown>) {
    if (
      typeof input?.email !== 'string' ||
      input.email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim()) ||
      (input.persona !== undefined && input.persona !== 'BUSINESS_DEVELOPER')
    )
      throw new BadRequestException('A valid email and Business Developer invitation are required');
    const email = input.email.trim().toLowerCase();
    return this.run(async () => {
      const token = randomBytes(32).toString('hex');
      const row = await this.organizations.invite(userId, orgId, email, token);
      return {
        id: row.id,
        email: row.email,
        status: row.status,
        expiresAt: row.expiresAt.toISOString(),
        persona: 'BUSINESS_DEVELOPER' as const,
        token,
      };
    });
  }
  invitationList(userId: string, orgId: string) {
    return this.run(async () =>
      (await this.organizations.invitationList(userId, orgId)).map((row) => ({
        ...row,
        status: row.status === 'PENDING' && row.expiresAt.getTime() <= Date.now() ? 'EXPIRED' : row.status,
        expiresAt: row.expiresAt.toISOString(),
        persona: 'BUSINESS_DEVELOPER' as const,
      })),
    );
  }
  revoke(userId: string, orgId: string, id: string) {
    return this.run(async () => {
      await this.organizations.revoke(userId, orgId, id);
      return { revoked: true };
    });
  }
  accept(identity: ConsoleIdentity, token: string) {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new NotFoundException('Invitation not found');
    return this.run(() => this.organizations.accept(identity, token));
  }
}

/**
 * A key's scopes are what it can do, whoever holds it. The Owner manages every key; a Business
 * Developer only read-only keys, so it cannot revoke or rename the Owner's write keys.
 */
function requireKeyAuthority(role: 'OWNER' | 'BUSINESS_DEVELOPER', credential: Pick<ApiCredential, 'scopes'>) {
  if (role === 'OWNER') return;
  if ((credential.scopes as string[]).some((scope) => scope !== 'read'))
    throw new ForbiddenException('Only the Owner can revoke or rename a key with more than read access');
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
