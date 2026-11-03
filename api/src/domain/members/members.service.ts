import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { MemberDirectoryQuery, MemberProfilePatch } from '@octap/contracts';
import { MembersRepository } from '#infra/db/repositories/members.repository.js';
import { ConsoleAccessError, ConsoleNotFoundError } from '#infra/db/repositories/console-organizations.repository.js';
import { CreditsService } from '../credits/credits.service.js';

const uuid = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
@Injectable()
export class MembersService {
  constructor(
    private readonly members: MembersRepository,
    private readonly credits: CreditsService,
  ) {}
  private async run<T>(action: () => Promise<T>) {
    try {
      return await action();
    } catch (error) {
      if (error instanceof ConsoleAccessError) throw new ForbiddenException('Organization access is required');
      if (error instanceof ConsoleNotFoundError) throw new NotFoundException('Member not found in this organization');
      const code = error as { cause?: { code?: string }; code?: string };
      if ((code.cause?.code ?? code.code) === '23505')
        throw new ConflictException('External member ID is already assigned in this organization');
      throw error;
    }
  }
  list(userId: string, orgId: string, query: Record<string, unknown>) {
    if (Object.keys(query).some((key) => !['limit', 'cursor', 'q', 'status', 'externalMemberId'].includes(key)))
      throw new BadRequestException('Unsupported member search fields');
    const limit = query.limit === undefined ? 25 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BadRequestException('limit must be 1–100');
    if (query.cursor !== undefined && (typeof query.cursor !== 'string' || !uuid.test(query.cursor)))
      throw new BadRequestException('Invalid cursor');
    for (const key of ['q', 'externalMemberId']) {
      if (query[key] !== undefined && (typeof query[key] !== 'string' || query[key].length > 160))
        throw new BadRequestException(`Invalid ${key}`);
    }
    if (query.status !== undefined && !['ACTIVE', 'BLOCKED'].includes(String(query.status)))
      throw new BadRequestException('Invalid status');
    return this.run(() => this.members.list(userId, orgId, { ...query, limit } as MemberDirectoryQuery));
  }
  detail(userId: string, orgId: string, memberId: string) {
    return this.run(async () => {
      const member = await this.members.detail(userId, orgId, memberId);
      return { ...member, balance: await this.credits.getBalance(orgId, memberId) };
    });
  }
  patch(userId: string, orgId: string, memberId: string, input: Record<string, unknown>) {
    if (
      !input ||
      !Object.keys(input).length ||
      Object.keys(input).some((k) => !['status', 'externalMemberId', 'metadata'].includes(k))
    )
      throw new BadRequestException('Only status, externalMemberId and metadata may be changed');
    if (input.status !== undefined && !['ACTIVE', 'BLOCKED'].includes(String(input.status)))
      throw new BadRequestException('Invalid status');
    if (
      input.externalMemberId !== undefined &&
      input.externalMemberId !== null &&
      (typeof input.externalMemberId !== 'string' ||
        !input.externalMemberId.trim() ||
        input.externalMemberId.length > 160)
    )
      throw new BadRequestException('Invalid external member ID');
    if (
      input.metadata !== undefined &&
      (!input.metadata ||
        typeof input.metadata !== 'object' ||
        Array.isArray(input.metadata) ||
        JSON.stringify(input.metadata).length > 4096)
    )
      throw new BadRequestException('Metadata must be an object up to 4096 characters');
    return this.run(() => this.members.patch(userId, orgId, memberId, input as MemberProfilePatch));
  }
}
