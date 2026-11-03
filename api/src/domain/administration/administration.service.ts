import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { GovernanceProposal } from '@octap/contracts';
import { GovernanceRepository } from '#infra/db/repositories/governance.repository.js';
import {
  ConsoleAccessError,
  ConsoleConflictError,
  ConsoleNotFoundError,
} from '#infra/db/repositories/console-organizations.repository.js';
const uuid = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
@Injectable()
export class AdministrationService {
  constructor(private readonly governance: GovernanceRepository) {}
  private reason(value: unknown) {
    if (typeof value !== 'string' || !value.trim() || value.length > 1000)
      throw new BadRequestException('A reason of 1–1000 characters is required');
    return value.trim();
  }
  async propose(actor: string, orgId: string, body: Record<string, unknown>, platform: boolean) {
    const reason = this.reason(body?.reason);
    if (!platform && body?.requestType === 'UPDATE_PROFILE')
      throw new BadRequestException('Use the organization profile endpoint to change the display name directly');
    if (
      !['UPDATE_PROFILE', 'TRANSFER_OWNERSHIP', 'DEACTIVATE', 'SUSPEND', 'REINSTATE'].includes(
        String(body?.requestType),
      )
    )
      throw new BadRequestException('Invalid request type');
    const payload = body.payload ?? {};
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      throw new BadRequestException('Invalid payload');
    const input = payload as Record<string, unknown>;
    const allowed =
      body.requestType === 'TRANSFER_OWNERSHIP'
        ? ['targetUserId']
        : body.requestType === 'UPDATE_PROFILE'
          ? ['name']
          : [];
    if (Object.keys(input).some((key) => !allowed.includes(key)))
      throw new BadRequestException('Unexpected request fields');
    if (
      body.requestType === 'TRANSFER_OWNERSHIP' &&
      (typeof input.targetUserId !== 'string' || !uuid.test(input.targetUserId))
    )
      throw new BadRequestException('Valid targetUserId is required');
    if (
      body.requestType === 'UPDATE_PROFILE' &&
      (typeof input.name !== 'string' || input.name.trim().length < 2 || input.name.length > 160)
    )
      throw new BadRequestException('A display name of 2–160 characters is required');
    try {
      return await this.governance.propose(
        actor,
        orgId,
        { requestType: body.requestType, reason, payload } as GovernanceProposal,
        platform,
      );
    } catch (error) {
      if (error instanceof ConsoleAccessError) throw new ForbiddenException('Owner access required');
      if (error instanceof ConsoleConflictError) throw new ConflictException(error.message);
      if (error instanceof ConsoleNotFoundError) throw new NotFoundException('Organization not found');
      throw error;
    }
  }
  async list(actor: string, query: Record<string, unknown>) {
    const limit = query.limit === undefined ? 25 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BadRequestException('Invalid limit');
    if (query.status !== undefined && !['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'].includes(String(query.status)))
      throw new BadRequestException('Invalid status');
    for (const key of ['cursor', 'organizationId'])
      if (query[key] !== undefined && (typeof query[key] !== 'string' || !uuid.test(query[key])))
        throw new BadRequestException(`Invalid ${key}`);
    try { return await this.governance.list(actor, { ...query, limit }); }
    catch (error) { if (error instanceof ConsoleAccessError) throw new ForbiddenException('System Admin role required'); throw error; }
  }
  async decide(actor: string, id: string, approve: boolean, reason: unknown) {
    const reviewReason = this.reason(reason);
    try {
      return await this.governance.decide(actor, id, approve, reviewReason);
    } catch (error) {
      if (error instanceof ConsoleAccessError) throw new ForbiddenException('System Admin role required');
      if (error instanceof ConsoleConflictError) throw new ConflictException(error.message);
      if (error instanceof ConsoleNotFoundError) throw new NotFoundException('Request not found');
      throw error;
    }
  }
}
