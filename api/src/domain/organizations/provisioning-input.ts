import { BadRequestException } from '@nestjs/common';
import type { ProvisionOrganizationInput } from '@octap/contracts';
export function provisioningInput(input: Record<string, unknown>): ProvisionOrganizationInput {
  if (
    !input ||
    Object.keys(input).some(
      (key) => !['earnBps', 'expiryDays', 'totalBudget', 'shardCount', 'idempotencyKey'].includes(key),
    )
  )
    throw new BadRequestException('Unexpected provisioning fields');
  const bounds = {
    earnBps: [0, 10000],
    expiryDays: [1, 3650],
    totalBudget: [1, Number.MAX_SAFE_INTEGER],
    shardCount: [1, 16],
  };
  for (const [key, [min, max]] of Object.entries(bounds))
    if (typeof input[key] !== 'number' || !Number.isSafeInteger(input[key]) || input[key] < min || input[key] > max)
      throw new BadRequestException(`Invalid ${key}`);
  if (typeof input.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey))
    throw new BadRequestException(
      'Use an idempotency key of 8–128 letters, numbers, periods, underscores, colons or hyphens',
    );
  return input as unknown as ProvisionOrganizationInput;
}
