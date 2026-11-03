import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { ConsoleIdentity, OrganizationApplicationInput } from '@octap/contracts';
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
  apply(userId: string, input: Record<string, unknown>) {
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
      id: await this.organizations.apply(userId, {
        ...profile,
        slug,
        organizationType,
      } satisfies OrganizationApplicationInput),
    }));
  }
  applications(userId: string, platform = false) {
    return this.run(() => this.organizations.applications(userId, platform));
  }
  decide(userId: string, id: string, approve: boolean, reason?: unknown) {
    if (!approve && (typeof reason !== 'string' || !reason.trim() || reason.length > 1000))
      throw new BadRequestException('A rejection reason is required (up to 1000 characters)');
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
  credentials(userId: string, orgId: string) {
    return this.run(() => this.organizations.credentials(userId, orgId));
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
