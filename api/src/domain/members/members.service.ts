import { Injectable } from '@nestjs/common';
import { MembersRepository } from '../../infra/db/repositories/members.repository.js';
import type { EnsureMemberByPhoneRequest, EnsureMemberByPhoneResponse } from '@octap/contracts';

@Injectable()
export class MembersService {
  constructor(private readonly membersRepo: MembersRepository) {}

  async ensureByPhone(organizationId: string, request: EnsureMemberByPhoneRequest): Promise<EnsureMemberByPhoneResponse> {
    return this.membersRepo.findOrCreateByPhone(organizationId, request.phoneNumber, request.displayName);
  }
}
