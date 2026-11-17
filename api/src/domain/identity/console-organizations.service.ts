import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { ConsoleIdentity, OrganizationApplicationInput, OrganizationProfileInput } from '@octap/contracts';
import {
  ConsoleAccessError,
  ConsoleConflictError,
  ConsoleGoneError,
  ConsoleNotFoundError,
  ConsoleOrganizationsRepository,
  ConsoleValidationError,
} from '#infra/db/repositories/console-organizations.repository.js';
import {
  IDENTITY_FIELDS,
  IdentityInputError,
  identityProblem,
  parseIdentityChange,
} from '#infra/db/organization-identity.rules.js';

const LOGO_URL_MAX_LENGTH = 2048;

/** A display name: 2–160 characters once trimmed. */
function displayName(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 2 || value.length > 160)
    throw new BadRequestException('Invalid name: use 2–160 characters');
  return value.trim();
}

/** An `https:` logo URL, or null to remove it. */
function logoUrl(value: unknown): string | null {
  if (value === null) return null;
  const tooLong = `The logo must be an https URL of up to ${LOGO_URL_MAX_LENGTH} characters`;
  if (typeof value !== 'string' || value.length > LOGO_URL_MAX_LENGTH) throw new BadRequestException(tooLong);
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new BadRequestException('The logo must be an https URL');
  }
  if (url.protocol !== 'https:') throw new BadRequestException('The logo must be an https URL');
  // Normalizing can percent-encode characters and make the URL longer: the stored form must fit.
  const normalized = url.toString();
  if (normalized.length > LOGO_URL_MAX_LENGTH) throw new BadRequestException(tooLong);
  return normalized;
}

@Injectable()
export class ConsoleOrganizationsService {
  constructor(private readonly organizations: ConsoleOrganizationsRepository) {}
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
  apply(userId: string, input: Record<string, unknown>, adminActorId?: string) {
    if (typeof input?.name !== 'string' || input.name.trim().length < 2 || input.name.length > 160)
      throw new BadRequestException('Invalid name');
    const name = input.name.trim();
    let identity;
    try {
      identity = parseIdentityChange(input);
    } catch (error) {
      if (error instanceof IdentityInputError) throw new BadRequestException(error.message);
      throw error;
    }
    const organizationType = identity.organizationType;
    if (!organizationType) throw new BadRequestException('Choose Individual / Household business or Company');
    const problem = identityProblem(
      {
        organizationType,
        legalName: identity.legalName ?? null,
        taxId: identity.taxId ?? null,
        representativeName: identity.representativeName ?? null,
      },
      identity.nationalId !== undefined,
    );
    if (problem) throw new BadRequestException(problem);
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
          name,
          legalName: identity.legalName ?? undefined,
          taxId: identity.taxId ?? undefined,
          representativeName: identity.representativeName ?? undefined,
          nationalId: identity.nationalId,
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
  /**
   * Display details only, applied immediately. Legal fields may be re-sent unchanged (the console
   * form sends the whole profile); a changed one is a 400 pointing at `UPDATE_IDENTITY`.
   */
  profile(userId: string, orgId: string, input: Record<string, unknown>) {
    const display: OrganizationProfileInput = {};
    if (input?.name !== undefined) display.name = displayName(input.name);
    if (input?.logoUrl !== undefined) display.logoUrl = logoUrl(input.logoUrl);
    const legal = Object.fromEntries(
      IDENTITY_FIELDS.filter((key) => input?.[key] !== undefined).map((key) => [key, input[key]]),
    );
    for (const [key, value] of Object.entries(legal))
      if (typeof value !== 'string') throw new BadRequestException(`Invalid ${key}`);
    if (display.name === undefined && display.logoUrl === undefined && Object.keys(legal).length === 0)
      throw new BadRequestException('Send a name or logoUrl to update');
    return this.run(async () => {
      await this.organizations.profile(userId, orgId, display, legal);
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
