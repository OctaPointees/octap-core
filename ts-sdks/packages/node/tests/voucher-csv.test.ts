import { describe, expect, it } from 'vitest';
import { parseVoucherCsv, suggestVoucherCode, VOUCHER_CSV_TEMPLATE, VOUCHER_CSV_TYPES } from '../src/index.js';

const HEADER = 'type,title,code,points_cost,value,item,claims_close_on';

describe('parseVoucherCsv', () => {
  it('reads every example row of the template, one per type', () => {
    const { items, rows, error } = parseVoucherCsv(VOUCHER_CSV_TEMPLATE);
    expect(error).toBeUndefined();
    expect(rows.filter((row) => row.problem)).toEqual([]);
    expect(items).toHaveLength(VOUCHER_CSV_TYPES.length);
    expect(items.map((item) => (item.terms as { kind: string }).kind)).toEqual([
      'PERCENT_OFF',
      'AMOUNT_OFF',
      'FREE_ITEM',
      'BUY_X_GET_Y',
      'FREE_SHIPPING',
      'FIXED_PRICE',
      'CUSTOM',
    ]);
  });

  it('builds the item the console builds, with terms in the octap.benefit.v1 shape', () => {
    const { items } = parseVoucherCsv(VOUCHER_CSV_TEMPLATE);
    expect(items[0]).toEqual({
      code: 'DRINKS-20',
      title: '20% off drinks',
      pointsCost: 300,
      discountType: 'PERCENTAGE',
      discountValue: '20',
      terms: {
        schema: 'octap.benefit.v1',
        kind: 'PERCENT_OFF',
        minOrderVnd: 200000,
        appliesTo: 'Drinks only',
        maxDiscountVnd: 50000,
      },
      totalSupply: 100,
      perMemberLimit: 1,
      startsAt: null,
      expiresAt: '2027-12-31T16:59:59.000Z',
      validForDays: 14,
    });
    // Quoted cells keep their commas; a kind without a discountType is described by terms alone.
    expect(items[2].terms).toMatchObject({ kind: 'FREE_ITEM', item: 'Latte, size M' });
    expect(items[3]).not.toHaveProperty('discountType');
    expect(items[3].terms).toMatchObject({ kind: 'BUY_X_GET_Y', buyQuantity: 1, getQuantity: 1 });
    expect(items[6]).toMatchObject({ description: 'Book 2 days ahead', terms: { benefit: 'One 60-minute treatment' } });
  });

  it('reports each bad row with its line and column, and leaves it out of items', () => {
    const { items, rows } = parseVoucherCsv(
      [
        HEADER,
        'free_item,A latte,LATTE,500,,Latte,2027-12-31',
        'free_item,Again,LATTE,500,,Latte,2027-12-31',
        'teleport,Nope,NOPE,1,,,',
        'percent_off,Too much,BIG,100,150,,',
        'free_item,No item,NO-ITEM,-5,,,',
      ].join('\n'),
    );
    expect(items.map((item) => item.code)).toEqual(['LATTE']);
    expect(rows.map((row) => [row.line, row.code, row.problem ?? null])).toEqual([
      [2, 'LATTE', null],
      [3, 'LATTE', 'code: LATTE is already used by line 2'],
      [4, 'NOPE', 'Unknown type "teleport"'],
      [5, 'BIG', 'value: Enter a percentage above 0, at most 100'],
      [6, 'NO-ITEM', 'points_cost: Enter a whole number of points (0 for free); item: Say which item is free'],
    ]);
  });

  it('keeps a corrected row whose code repeats an earlier row that was left out', () => {
    const { items, rows } = parseVoucherCsv(
      [
        HEADER,
        'free_item,A latte,LATTE,500,,Latte,not-a-date',
        'free_item,A latte,LATTE,500,,Latte,2027-12-31',
        'free_item,Again,LATTE,500,,Latte,2027-12-31',
      ].join('\n'),
    );
    expect(items.map((item) => item.code)).toEqual(['LATTE']);
    expect(rows.map((row) => [row.line, row.problem ?? null])).toEqual([
      [2, expect.stringMatching(/^claims_close_on: /)],
      [3, null],
      [4, 'code: LATTE is already used by line 3'],
    ]);
  });

  it('reads dates Excel rewrote, refuses an unclear one, and keeps the old column names', () => {
    const { items, rows } = parseVoucherCsv(
      [
        'type,title,code,points_cost,item,expires_on',
        'free_item,US,US,1,Latte,12/31/2027',
        'free_item,VN,VN,1,Latte,13/12/2027',
        'free_item,Unclear,UNCLEAR,1,Latte,05/02/2027',
      ].join('\r\n'),
    );
    expect(items.map((item) => item.expiresAt)).toEqual(['2027-12-31T16:59:59.000Z', '2027-12-13T16:59:59.000Z']);
    expect(rows[2].problem).toMatch(/could be 2027-02-05 or 2027-05-02/);
  });

  it('reads the days in the given UTC offset', () => {
    const csv = `${HEADER}\nfree_item,A latte,LATTE,500,,Latte,2027-12-31`;
    expect(parseVoucherCsv(csv, { utcOffset: 'Z' }).items[0].expiresAt).toBe('2027-12-31T23:59:59.000Z');
    expect(() => parseVoucherCsv(csv, { utcOffset: '7' })).toThrow(/utcOffset/);
  });

  it('makes a code from the title when the cell is empty', () => {
    const { items } = parseVoucherCsv(`${HEADER}\nfree_item,Trà sữa trân châu!,,100,,Trà sữa,`);
    expect(items[0].code).toBe('TRA-SUA-TRAN-CHAU');
    expect(suggestVoucherCode('Đồng giá 99k')).toBe('DONG-GIA-99K');
  });

  it('refuses the whole file when it is empty, misses a column or has too many rows', () => {
    expect(parseVoucherCsv('').error).toBe('The file is empty.');
    expect(parseVoucherCsv('title,code\nA,B').error).toMatch(/Missing column\(s\): type, points_cost/);
    const many = [HEADER, ...Array.from({ length: 101 }, (_, i) => `free_item,R${i},R${i},1,,Tea,`)].join('\n');
    expect(parseVoucherCsv(many).error).toMatch(/At most 100 vouchers per file; this one has 101/);
  });
});
