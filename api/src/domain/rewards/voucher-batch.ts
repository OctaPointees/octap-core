import { BadRequestException } from '@nestjs/common';
import { VOUCHER_BATCH_MAX_ITEMS, type VoucherBatchItem, type VoucherFieldDifference } from '@octap/contracts';
import type { VoucherBatchValues } from '#infra/db/repositories/rewards.repository.js';
import type { vouchers } from '#infra/db/schema/rewards.schema.js';
import { validateVoucher } from './voucher-validation.js';

type Voucher = typeof vouchers.$inferSelect;

/**
 * The fields a batch item sets, in the order differences are reported. `code` is the key, so it is
 * never a difference; `status` is not allowed in an item.
 */
export const BATCH_COMPARED_FIELDS = [
  'title',
  'description',
  'pointsCost',
  'discountType',
  'discountValue',
  'terms',
  'totalSupply',
  'perMemberLimit',
  'startsAt',
  'expiresAt',
  'validForDays',
  'metadata',
] as const satisfies readonly (keyof VoucherBatchValues)[];

/** The request body checks that fail the whole call (400); each item is checked on its own later. */
export function parseBatchRequest(body: unknown): { items: unknown[]; dryRun: boolean } {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new BadRequestException('Batch body must be an object');
  const { items, dryRun, ...rest } = body as { items?: unknown; dryRun?: unknown };
  if (Object.keys(rest).length) throw new BadRequestException('Batch body contains unsupported fields');
  if (!Array.isArray(items) || items.length < 1 || items.length > VOUCHER_BATCH_MAX_ITEMS)
    throw new BadRequestException(`items must be an array of 1 to ${VOUCHER_BATCH_MAX_ITEMS} vouchers`);
  if (dryRun !== undefined && typeof dryRun !== 'boolean') throw new BadRequestException('dryRun must be a boolean');
  return { items, dryRun: dryRun ?? false };
}

const FIELD_NAMES = new Set<string>([...BATCH_COMPARED_FIELDS, 'code', 'status']);

/**
 * The field a `validateVoucher` message is about. Its messages start with the field's name
 * (`pointsCost must be…`); the two that don't are mapped here. `null` for whole-body problems.
 */
export function errorField(message: string): string | null {
  if (/^Percentage discount/.test(message)) return 'discountValue';
  if (/^Voucher terms, title and description must fit/.test(message)) return 'terms';
  const first = /^(\w+)\b/.exec(message)?.[1];
  return first && FIELD_NAMES.has(first) ? first : null;
}

/** An item that passed every check, with its normalized values. */
export interface ValidBatchItem {
  index: number;
  code: string;
  values: VoucherBatchValues;
}

/** An item that failed a check; the service reports it as an `error` result. */
export interface InvalidBatchItem {
  index: number;
  code: string | null;
  error: { code: 'INVALID' | 'DUPLICATE_IN_BATCH'; field: string | null; message: string };
}

/**
 * Checks each item the way `createVoucher` checks one voucher, plus the batch rules: no `status`
 * (a batch is always DRAFT) and no `code` used twice in the same request (the later one fails).
 */
export function checkBatchItems(items: unknown[]): { valid: ValidBatchItem[]; invalid: InvalidBatchItem[] } {
  const valid: ValidBatchItem[] = [];
  const invalid: InvalidBatchItem[] = [];
  const seen = new Set<string>();
  items.forEach((raw, index) => {
    const item = raw as VoucherBatchItem;
    const code = raw && typeof raw === 'object' && typeof item.code === 'string' ? item.code : null;
    const fail = (error: InvalidBatchItem['error']) => invalid.push({ index, code, error });
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'status' in raw) {
      fail({
        code: 'INVALID',
        field: 'status',
        message: 'A batch is always created as DRAFT; activate it with activateVoucherBatch',
      });
      return;
    }
    try {
      validateVoucher(item);
    } catch (error) {
      if (!(error instanceof BadRequestException)) throw error;
      fail({ code: 'INVALID', field: errorField(error.message), message: error.message });
      return;
    }
    if (seen.has(item.code)) {
      fail({
        code: 'DUPLICATE_IN_BATCH',
        field: 'code',
        message: `code ${item.code} is used by an earlier item of this batch`,
      });
      return;
    }
    seen.add(item.code);
    valid.push({ index, code: item.code, values: toBatchValues(item) });
  });
  return { valid, invalid };
}

/** Every field set, the way a single create stores what was left out. */
export function toBatchValues(item: VoucherBatchItem): VoucherBatchValues {
  return {
    title: item.title,
    description: item.description ?? null,
    pointsCost: item.pointsCost ?? 0,
    discountType: item.discountType ?? null,
    discountValue: item.discountValue ?? null,
    terms: item.terms ?? null,
    totalSupply: item.totalSupply ?? null,
    perMemberLimit: item.perMemberLimit ?? null,
    startsAt: item.startsAt ? new Date(item.startsAt) : null,
    expiresAt: item.expiresAt ? new Date(item.expiresAt) : null,
    validForDays: item.validForDays ?? null,
    metadata: item.metadata ?? {},
  };
}

/** JSON with object keys sorted, so `{ a, b }` and `{ b, a }` compare equal. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value ?? null);
}

/** A field's value in the form two equal values share, whatever their spelling. */
function comparable(field: (typeof BATCH_COMPARED_FIELDS)[number], value: unknown): unknown {
  if (value === undefined || value === null) return field === 'metadata' ? '{}' : null;
  switch (field) {
    case 'startsAt':
    case 'expiresAt':
      // The same instant in any time zone: `…Z` and `…+07:00` can be equal.
      return (value as Date).getTime();
    case 'discountValue':
      // `numeric(12,2)` reads back as "20.00": "20" is the same amount.
      return Number(value).toFixed(2);
    case 'pointsCost':
      return Number(value);
    case 'terms':
    case 'metadata':
      return stableJson(value);
    default:
      return value;
  }
}

/** A field's value as the API shows it: dates as ISO strings. */
function shown(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : (value ?? null);
}

/** Where a stored voucher differs from an item's values, after normalizing both. */
export function voucherDifferences(stored: Voucher, values: VoucherBatchValues): VoucherFieldDifference[] {
  const differences: VoucherFieldDifference[] = [];
  for (const field of BATCH_COMPARED_FIELDS) {
    const before = stored[field];
    const after = values[field];
    if (comparable(field, before) !== comparable(field, after))
      differences.push({ field, stored: shown(before), sent: shown(after) });
  }
  return differences;
}
