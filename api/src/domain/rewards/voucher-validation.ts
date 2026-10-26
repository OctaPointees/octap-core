import { BadRequestException } from '@nestjs/common';
import type { CreateVoucherRequest, UpdateVoucherRequest } from '@octap/contracts';

/** Date.parse normalizes impossible calendar dates, so validate the components first. */
function isIsoDateTime(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match;
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(
    Number,
  );
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1] ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return false;
  if (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}

/** Shared by create and locked updates; reject malformed JSON before PostgreSQL sees it. */
export function validateVoucher(input: CreateVoucherRequest | UpdateVoucherRequest, partial = false): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BadRequestException('Voucher body must be an object');
  }
  const allowed = [
    'code',
    'title',
    'description',
    'pointsCost',
    'discountType',
    'discountValue',
    'totalSupply',
    'startsAt',
    'expiresAt',
    'metadata',
    'status',
  ];
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new BadRequestException('Voucher body contains unsupported fields');
  }
  for (const key of ['code', 'title'] as const) {
    const value = input[key];
    if (
      (!partial || value !== undefined) &&
      (typeof value !== 'string' || !value.trim() || value.length > (key === 'code' ? 80 : 200))
    ) {
      throw new BadRequestException(`${key} must be a nonempty string within its length limit`);
    }
  }
  if (input.code !== undefined && !/^[a-zA-Z0-9_-]+$/.test(input.code)) {
    throw new BadRequestException('code must contain only letters, numbers, underscores or hyphens');
  }
  if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 4000)) {
    throw new BadRequestException('description must be a string of at most 4000 characters');
  }
  if (input.pointsCost !== undefined && (!Number.isSafeInteger(input.pointsCost) || input.pointsCost < 0)) {
    throw new BadRequestException('pointsCost must be a nonnegative safe integer');
  }
  if (
    input.totalSupply !== undefined &&
    input.totalSupply !== null &&
    (!Number.isInteger(input.totalSupply) || input.totalSupply < 1 || input.totalSupply > 2147483647)
  ) {
    throw new BadRequestException('totalSupply must be a positive 32-bit integer or null');
  }
  if (
    (!partial || input.discountType !== undefined) &&
    !['PERCENTAGE', 'FIXED_AMOUNT', 'FREE_ITEM'].includes(input.discountType ?? '')
  ) {
    throw new BadRequestException('discountType must be PERCENTAGE, FIXED_AMOUNT or FREE_ITEM');
  }
  if (
    input.discountValue !== undefined &&
    input.discountValue !== null &&
    (typeof input.discountValue !== 'string' ||
      !/^\d{1,10}(\.\d{1,2})?$/.test(input.discountValue) ||
      Number(input.discountValue) <= 0)
  ) {
    throw new BadRequestException('discountValue must be a positive decimal string with at most two decimal places');
  }
  if (!partial && input.discountType !== 'FREE_ITEM' && !input.discountValue) {
    throw new BadRequestException('discountValue is required for a monetary or percentage reward');
  }
  if (input.discountType === 'PERCENTAGE' && input.discountValue && Number(input.discountValue) > 100) {
    throw new BadRequestException('Percentage discount cannot exceed 100');
  }
  for (const key of ['startsAt', 'expiresAt'] as const) {
    const value = input[key];
    if (value !== undefined && value !== null && (typeof value !== 'string' || !isIsoDateTime(value))) {
      throw new BadRequestException(`${key} must be an ISO date-time with a timezone or null`);
    }
  }
  if (input.startsAt && input.expiresAt && Date.parse(input.startsAt) >= Date.parse(input.expiresAt)) {
    throw new BadRequestException('expiresAt must be later than startsAt');
  }
  if (
    input.metadata !== undefined &&
    (!input.metadata || typeof input.metadata !== 'object' || Array.isArray(input.metadata))
  ) {
    throw new BadRequestException('metadata must be an object');
  }
  if (input.status !== undefined && !['DRAFT', 'ACTIVE', 'PAUSED'].includes(input.status)) {
    throw new BadRequestException('Editable status must be DRAFT, ACTIVE or PAUSED');
  }
}
