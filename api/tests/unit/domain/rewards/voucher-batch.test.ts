import { describe, expect, it } from 'vitest';
import {
  BATCH_COMPARED_FIELDS,
  STATUS_COUNTS_LIST_EVERY_STATUS,
  checkBatchItems,
  errorField,
  parseBatchRequest,
  toBatchValues,
  voucherDifferences,
} from '#domain/rewards/voucher-batch.js';
import type { vouchers } from '#infra/db/schema/rewards.schema.js';

type Voucher = typeof vouchers.$inferSelect;

const item = { code: 'SALE', title: 'Sale', discountType: 'PERCENTAGE' as const, discountValue: '20', pointsCost: 100 };

/** A stored row as Postgres returns it: numeric as "20.00", dates as Date, defaults filled in. */
function stored(overrides: Partial<Voucher> = {}): Voucher {
  return {
    id: 'v-1',
    organizationId: 'org',
    code: 'SALE',
    title: 'Sale',
    description: null,
    pointsCost: 100,
    discountType: 'PERCENTAGE',
    discountValue: '20.00',
    terms: null,
    publishStatus: 'NOT_PUBLISHED',
    suiTermsId: null,
    refundPolicySnapshot: null,
    totalSupply: null,
    perMemberLimit: null,
    validForDays: null,
    claimedCount: 0,
    status: 'DRAFT',
    startsAt: null,
    expiresAt: null,
    metadata: {},
    importBatchId: null,
    campaignId: null,
    createdByUserId: null,
    createdByCredentialId: null,
    activatedByUserId: null,
    activatedByCredentialId: null,
    activatedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('parseBatchRequest', () => {
  it('takes 1 to 100 items and an optional boolean dryRun', () => {
    expect(parseBatchRequest({ items: [item] })).toEqual({
      items: [item],
      dryRun: false,
      name: null,
      campaignId: null,
    });
    expect(parseBatchRequest({ items: [item], dryRun: true }).dryRun).toBe(true);
    expect(parseBatchRequest({ items: Array(100).fill(item) }).items).toHaveLength(100);
  });

  it('trims the name, makes a blank one null, and refuses one too long or not a string', () => {
    expect(parseBatchRequest({ items: [item], name: '  catalog.csv ' }).name).toBe('catalog.csv');
    expect(parseBatchRequest({ items: [item], name: '   ' }).name).toBeNull();
    expect(parseBatchRequest({ items: [item], name: null }).name).toBeNull();
    expect(parseBatchRequest({ items: [item], name: 'x'.repeat(120) }).name).toHaveLength(120);
    expect(() => parseBatchRequest({ items: [item], name: 'x'.repeat(121) })).toThrow(/at most 120/);
    expect(() => parseBatchRequest({ items: [item], name: 5 })).toThrow(/name must be a string/);
  });

  it('refuses the whole request when its shape is wrong', () => {
    for (const [body, message] of [
      [null, /must be an object/],
      [[item], /must be an object/],
      [{}, /1 to 100/],
      [{ items: 'x' }, /1 to 100/],
      [{ items: [] }, /1 to 100/],
      [{ items: Array(101).fill(item) }, /1 to 100/],
      [{ items: [item], dryRun: 1 }, /dryRun must be a boolean/],
      [{ items: [item], status: 'ACTIVE' }, /unsupported fields/],
    ] as const) {
      expect(() => parseBatchRequest(body)).toThrow(message);
    }
  });
});

describe('errorField', () => {
  it('names the field a validateVoucher message is about, or null for the whole body', () => {
    expect(errorField('pointsCost must be a nonnegative safe integer')).toBe('pointsCost');
    expect(errorField('expiresAt must be later than startsAt')).toBe('expiresAt');
    expect(errorField('Percentage discount cannot exceed 100')).toBe('discountValue');
    expect(errorField('Voucher terms, title and description must fit in 900 bytes because …')).toBe('terms');
    expect(errorField('Voucher body contains unsupported fields')).toBeNull();
    expect(errorField('Voucher body must be an object')).toBeNull();
  });
});

describe('checkBatchItems', () => {
  it('checks each item on its own, refuses status, and fails a code used twice after its first use', () => {
    const { valid, invalid } = checkBatchItems([
      item,
      { ...item, code: 'BAD', pointsCost: -5 },
      item,
      { ...item, code: 'S', status: 'DRAFT' },
      'not an object',
      { ...item, code: 'OTHER' },
    ]);
    expect(valid.map((v) => [v.index, v.code])).toEqual([
      [0, 'SALE'],
      [5, 'OTHER'],
    ]);
    expect(invalid).toEqual([
      { index: 1, code: 'BAD', error: { code: 'INVALID', field: 'pointsCost', message: expect.any(String) } },
      { index: 2, code: 'SALE', error: { code: 'DUPLICATE_IN_BATCH', field: 'code', message: expect.any(String) } },
      { index: 3, code: 'S', error: expect.objectContaining({ code: 'INVALID', field: 'status' }) },
      { index: 4, code: null, error: expect.objectContaining({ code: 'INVALID', field: null }) },
    ]);
  });

  it('lets an unexpected error through instead of reporting it as an item error', () => {
    const exploding = Object.defineProperty({ ...item }, 'title', {
      get() {
        throw new TypeError('boom');
      },
      enumerable: true,
    });
    expect(() => checkBatchItems([exploding])).toThrow('boom');
  });
});

describe('toBatchValues', () => {
  it('fills what was left out the way a single create stores it', () => {
    expect(toBatchValues({ code: 'X', title: 'X', discountType: 'FREE_ITEM' })).toEqual({
      title: 'X',
      description: null,
      pointsCost: 0,
      discountType: 'FREE_ITEM',
      discountValue: null,
      terms: null,
      totalSupply: null,
      perMemberLimit: null,
      startsAt: null,
      expiresAt: null,
      validForDays: null,
      metadata: {},
    });
  });
});

describe('voucherDifferences', () => {
  it('finds none when the same values are spelled differently', () => {
    const row = stored({
      startsAt: new Date('2027-01-01T00:00:00.000Z'),
      terms: { kind: 'PERCENT_OFF', cap: { vnd: 50000, note: 'x' } },
      metadata: null,
    });
    const values = toBatchValues({
      ...item,
      discountValue: '20',
      startsAt: '2027-01-01T07:00:00+07:00',
      terms: { cap: { note: 'x', vnd: 50000 }, kind: 'PERCENT_OFF' },
    });
    expect(voucherDifferences(row, values)).toEqual([]);
  });

  it('reports each changed field with the stored and the sent value, dates as ISO strings', () => {
    const row = stored({ expiresAt: new Date('2027-01-01T00:00:00.000Z'), terms: { list: [1, 2] } });
    const values = toBatchValues({
      ...item,
      title: 'New',
      pointsCost: 0,
      discountValue: '25',
      expiresAt: '2027-02-01T00:00:00.000Z',
      terms: { list: [2, 1] },
      totalSupply: 10,
    });
    expect(voucherDifferences(row, values)).toEqual([
      { field: 'title', stored: 'Sale', sent: 'New' },
      { field: 'pointsCost', stored: 100, sent: 0 },
      { field: 'discountValue', stored: '20.00', sent: '25' },
      // Array order is meaningful.
      { field: 'terms', stored: { list: [1, 2] }, sent: { list: [2, 1] } },
      { field: 'totalSupply', stored: null, sent: 10 },
      { field: 'expiresAt', stored: '2027-01-01T00:00:00.000Z', sent: '2027-02-01T00:00:00.000Z' },
    ]);
  });

  it('keeps the status counts type in step with the voucher statuses', () => {
    expect(STATUS_COUNTS_LIST_EVERY_STATUS).toBe(true);
  });

  it('compares every field a batch item can set', () => {
    expect([...BATCH_COMPARED_FIELDS].sort()).toEqual(Object.keys(toBatchValues(item)).sort());
  });
});
