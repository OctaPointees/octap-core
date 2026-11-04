import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { MemberEligibilityError } from '#infra/db/repositories/member-eligibility.js';

export function mapMemberEligibilityError(error: unknown): unknown {
  if (!(error instanceof MemberEligibilityError)) return error;
  return error.kind === 'NOT_FOUND' ? new NotFoundException(error.message) : new ForbiddenException(error.message);
}
