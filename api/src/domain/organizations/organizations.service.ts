import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ConsoleAccessError,
  ConsoleConflictError,
  ConsoleNotFoundError,
} from '#infra/db/repositories/console-access.js';
import { OrganizationsRepository } from '#infra/db/repositories/organizations.repository.js';
import { OperationPayloadConflictError } from '#infra/db/repositories/operations.repository.js';
import { ConsoleOrganizationsService } from '../identity/console-organizations.service.js';
import { provisioningInput } from './provisioning-input.js';
import { UUID_PATTERN as uuid } from '#infra/db/repositories/console-access.js';
@Injectable()
export class OrganizationsService {
  constructor(
    private readonly organizations: OrganizationsRepository,
    private readonly onboarding: ConsoleOrganizationsService,
  ) {}
  private async run<T>(action: () => Promise<T>) {
    try {
      return await action();
    } catch (error) {
      if (error instanceof ConsoleAccessError) throw new ForbiddenException(error.message);
      if (error instanceof ConsoleConflictError) throw new ConflictException(error.message);
      if (error instanceof ConsoleNotFoundError) throw new NotFoundException(error.message);
      throw error;
    }
  }
  list(actor: string, query: Record<string, unknown>) {
    const limit = query.limit === undefined ? 25 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BadRequestException('Invalid limit');
    if (query.cursor !== undefined && (typeof query.cursor !== 'string' || !uuid.test(query.cursor)))
      throw new BadRequestException('Invalid cursor');
    if (
      query.status !== undefined &&
      !['ACTIVE', 'SUSPENDED', 'PENDING_APPROVAL', 'ARCHIVED'].includes(String(query.status))
    )
      throw new BadRequestException('Invalid status');
    if (query.q !== undefined && (typeof query.q !== 'string' || query.q.length > 160))
      throw new BadRequestException('Invalid search');
    return this.run(() => this.organizations.list(actor, { ...query, limit }));
  }
  detail(actor: string, orgId: string) {
    return this.run(() => this.organizations.detail(actor, orgId));
  }
  create(actor: string, input: Record<string, unknown>) {
    if (typeof input?.ownerUserId !== 'string' || !uuid.test(input.ownerUserId))
      throw new BadRequestException('Choose an existing Google-bound initial Owner');
    return this.onboarding.apply(input.ownerUserId, input, actor);
  }
  owners(actor: string, query: unknown) {
    if (typeof query !== 'string' || query.trim().length < 2 || query.length > 160)
      throw new BadRequestException('Search existing Google users with 2–160 characters');
    return this.run(() => this.organizations.owners(actor, query.trim()));
  }
  resolve(slug: string) {
    if (!/^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/.test(slug)) throw new BadRequestException('Invalid organization slug');
    return this.run(() => this.organizations.resolve(slug));
  }
  async provision(actor: string, orgId: string, input: Record<string, unknown>) {
    const parsed = provisioningInput(input);
    try {
      return await this.run(() => this.organizations.enqueue(actor, orgId, parsed));
    } catch (error) {
      if (error instanceof OperationPayloadConflictError) throw new ConflictException(error.message);
      throw error;
    }
  }
}
