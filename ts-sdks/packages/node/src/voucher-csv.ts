import { VOUCHER_BATCH_MAX_ITEMS, VOUCHER_MAX_VALID_FOR_DAYS, type VoucherBatchItem } from '@octap/contracts';

/**
 * Reads the Octap voucher CSV template, the same file the console imports, into items for
 * `createVouchers`. It makes the same checks as the console: a row it can't read, that breaks a
 * rule, or that repeats an earlier row's code is reported with a `problem` and left out of `items`.
 * Core still checks every item when it is sent.
 */

/** Marks `terms` written in this shape, so the console and any reader know which fields to expect. */
export const VOUCHER_BENEFIT_SCHEMA = 'octap.benefit.v1';

/** The reward kinds of the template, as `terms.kind`. */
export type VoucherBenefitKind =
  'PERCENT_OFF' | 'AMOUNT_OFF' | 'FREE_ITEM' | 'BUY_X_GET_Y' | 'FREE_SHIPPING' | 'FIXED_PRICE' | 'CUSTOM';

/** The `type` column's values, one per kind. */
export const VOUCHER_CSV_TYPES = [
  'percent_off',
  'amount_off',
  'free_item',
  'buy_x_get_y',
  'free_shipping',
  'fixed_price',
  'custom',
] as const;

const COLUMNS = [
  'type',
  'title',
  'code',
  'points_cost',
  'value',
  'max_discount_vnd',
  'min_order_vnd',
  'item',
  'buy_quantity',
  'get_quantity',
  'price_vnd',
  'benefit',
  'applies_to',
  'total_supply',
  'per_member_limit',
  'claims_open_on',
  'claims_close_on',
  'valid_for_days',
  'description',
] as const;
type Column = (typeof COLUMNS)[number];

/** Headers of earlier templates, still read so an old file keeps working. */
const LEGACY_HEADERS: Partial<Record<string, Column>> = { starts_on: 'claims_open_on', expires_on: 'claims_close_on' };

const KIND_ALIASES: Record<string, VoucherBenefitKind> = {
  percent_off: 'PERCENT_OFF',
  percent: 'PERCENT_OFF',
  amount_off: 'AMOUNT_OFF',
  amount: 'AMOUNT_OFF',
  free_item: 'FREE_ITEM',
  buy_x_get_y: 'BUY_X_GET_Y',
  free_shipping: 'FREE_SHIPPING',
  free_delivery: 'FREE_SHIPPING',
  fixed_price: 'FIXED_PRICE',
  special_price: 'FIXED_PRICE',
  custom: 'CUSTOM',
};

/** The template with one example row per kind, the same as the console's download. */
export const VOUCHER_CSV_TEMPLATE = [
  COLUMNS.join(','),
  'percent_off,20% off drinks,DRINKS-20,300,20,50000,200000,,,,,,Drinks only,100,1,,2027-12-31,14,',
  'amount_off,30000 off,SAVE-30K,400,30000,,150000,,,,,,,,3,,2027-12-31,30,',
  'free_item,A free latte,FREE-LATTE,500,,,,"Latte, size M",,,,,,50,,,2027-12-31,30,',
  'buy_x_get_y,Buy 1 get 1 tea,B1G1-TEA,600,,,,Milk tea,1,1,,,,,1,,2027-12-31,,',
  'free_shipping,Free delivery,FREE-SHIP,200,,20000,100000,,,,,,,,,,2027-12-31,,',
  'fixed_price,Combo 99k,COMBO-99K,350,,,,Burger and drink,,,99000,,,,,,2027-12-31,7,',
  'custom,Spa afternoon,SPA-PASS,2000,,,,,,,,One 60-minute treatment,,10,1,,2027-12-31,,Book 2 days ahead',
].join('\n');

/** One row of the file: the item sent to Core, or why it was left out. */
export interface VoucherCsvRow {
  /** The row's line in the file; the header is line 1. */
  line: number;
  /** The row's code (made from its title when the cell is empty); `null` when it has none. */
  code: string | null;
  /** Set when the row passed every check. */
  item?: VoucherBatchItem;
  /** Why the row was left out, naming the CSV column: `points_cost: Enter a whole number…`. */
  problem?: string;
}

export interface ParsedVoucherCsv {
  /**
   * The rows that passed, in file order, ready for `createVouchers`. `items[i]` is the item of
   * `rows.filter((row) => row.item)[i]`, so a result's `index` leads back to its line.
   */
  items: VoucherBatchItem[];
  /** Every row of the file, with its item or its problem. */
  rows: VoucherCsvRow[];
  /** Set when the whole file is refused (empty, a required column missing, too many rows). */
  error?: string;
}

export interface ParseVoucherCsvOptions {
  /**
   * The UTC offset dates are read in: `claims_open_on` starts at 00:00:00 and `claims_close_on` ends
   * at 23:59:59 of that day there. Defaults to `+07:00` (Vietnam). `Z` is UTC.
   */
  utcOffset?: string;
}

/**
 * Reads a CSV in the Octap voucher template into items for `createVouchers`.
 *
 * ```ts
 * const { items, rows, error } = parseVoucherCsv(await readFile('rewards.csv', 'utf8'));
 * if (error) throw new Error(error);
 * for (const row of rows) if (row.problem) console.warn(`line ${row.line}: ${row.problem}`);
 * const preview = await client.createVouchers(items, { dryRun: true });
 * ```
 */
export function parseVoucherCsv(text: string, options: ParseVoucherCsvOptions = {}): ParsedVoucherCsv {
  const offset = options.utcOffset ?? '+07:00';
  if (!/^(Z|[+-](0\d|1[0-4]):[0-5]\d)$/.test(offset))
    throw new TypeError(`utcOffset must look like +07:00, -05:00 or Z; got "${offset}"`);
  const [header, ...body] = parseCsv(text);
  if (!header) return { items: [], rows: [], error: 'The file is empty.' };
  const index: string[] = header.map((h) => {
    const name = h.trim().toLowerCase();
    return LEGACY_HEADERS[name] ?? name;
  });
  const missing = ['type', 'title', 'points_cost'].filter((h) => !index.includes(h));
  if (missing.length)
    return { items: [], rows: [], error: `Missing column(s): ${missing.join(', ')}. Use the template.` };
  if (body.length > VOUCHER_BATCH_MAX_ITEMS)
    return {
      items: [],
      rows: [],
      error: `At most ${VOUCHER_BATCH_MAX_ITEMS} vouchers per file; this one has ${body.length}.`,
    };

  const seen = new Map<string, number>();
  const rows = body.map((cells, i): VoucherCsvRow => {
    const line = i + 2;
    const cell = (column: Column) => {
      const at = index.indexOf(column);
      return at < 0 ? '' : (cells[at] ?? '').trim();
    };
    const row = readRow(cell, offset);
    const code = row.item?.code ?? (row.code || null);
    const problems = [...row.problems];
    const earlier = code ? seen.get(code) : undefined;
    if (code && earlier && !problems.length) problems.push(`code: ${code} is already used by line ${earlier}`);
    // Only a row that is sent takes its code: a corrected copy of a bad row is not a repeat.
    if (code && !earlier && !problems.length) seen.set(code, line);
    return problems.length || !row.item
      ? { line, code, problem: problems.join('; ') || 'This row could not be read' }
      : { line, code, item: row.item };
  });
  return { items: rows.flatMap((row) => (row.item ? [row.item] : [])), rows };
}

const CODE_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const whole = (value: string) => /^\d+$/.test(value);
const positiveAmount = (value: string) => /^\d{1,10}(\.\d{1,2})?$/.test(value) && Number(value) > 0;

/** `Trà sữa trân châu!` → `TRA-SUA-TRAN-CHAU`, as the console makes a code from a title. */
export function suggestVoucherCode(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'D')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

/** One row's checks, and its item when they all pass. Mirrors the console's form. */
function readRow(
  cell: (column: Column) => string,
  offset: string,
): { item?: VoucherBatchItem; code: string; problems: string[] } {
  const problems: string[] = [];
  const fail = (column: Column, message: string) => problems.push(`${column}: ${message}`);
  const typeCell = cell('type').toLowerCase();
  const kind = KIND_ALIASES[typeCell] ?? KIND_ALIASES[typeCell.replace(/\s+/g, '_')];
  if (!kind) problems.push(`Unknown type "${cell('type')}"`);

  const title = cell('title');
  const code = cell('code') || suggestVoucherCode(title);
  if (!title) fail('title', 'Enter a title');
  else if (title.length > 200) fail('title', 'At most 200 characters');
  if (!CODE_PATTERN.test(code)) fail('code', 'Letters, numbers, - and _ only (at most 80)');
  const points = cell('points_cost');
  if (!whole(points)) fail('points_cost', 'Enter a whole number of points (0 for free)');

  const positiveWhole = (column: Column, message: string) => {
    const value = cell(column);
    if (!value) return null;
    if (!(whole(value) && Number(value) > 0)) fail(column, message);
    return Number(value);
  };
  const totalSupply = positiveWhole('total_supply', 'Enter a positive whole number, or leave empty for unlimited');
  const perMemberLimit = positiveWhole(
    'per_member_limit',
    'Enter a positive whole number, or leave empty for no limit',
  );
  const days = cell('valid_for_days');
  if (days && !(whole(days) && Number(days) >= 1 && Number(days) <= VOUCHER_MAX_VALID_FOR_DAYS))
    fail('valid_for_days', `Enter a whole number of days from 1 to ${VOUCHER_MAX_VALID_FOR_DAYS}`);

  const date = (column: Column) => {
    const value = cell(column);
    if (!value) return '';
    const read = csvDate(value);
    if ('problem' in read) {
      fail(column, read.problem);
      return '';
    }
    return read.day;
  };
  const opens = date('claims_open_on');
  const closes = date('claims_close_on');
  if (opens && closes && opens > closes) fail('claims_close_on', 'Must be on or after the opening date');

  const vnd = (column: Column) => {
    const value = cell(column);
    if (value && !whole(value)) fail(column, 'Enter an amount in VND');
    return value;
  };
  const minOrder = vnd('min_order_vnd');
  const terms: Record<string, unknown> = { schema: VOUCHER_BENEFIT_SCHEMA, kind: kind ?? 'CUSTOM' };
  const setNumber = (key: string, value: string) => {
    if (value) terms[key] = Number(value);
  };
  setNumber('minOrderVnd', minOrder);
  if (cell('applies_to')) terms.appliesTo = cell('applies_to');

  let discountType: VoucherBatchItem['discountType'];
  let discountValue: string | undefined;
  const value = cell('value');
  const item = cell('item');
  switch (kind) {
    case 'PERCENT_OFF':
      if (!positiveAmount(value) || Number(value) > 100) fail('value', 'Enter a percentage above 0, at most 100');
      setNumber('maxDiscountVnd', vnd('max_discount_vnd'));
      discountType = 'PERCENTAGE';
      discountValue = value;
      break;
    case 'AMOUNT_OFF':
      if (!positiveAmount(value)) fail('value', 'Enter an amount in VND');
      discountType = 'FIXED_AMOUNT';
      discountValue = value;
      break;
    case 'FREE_ITEM':
      if (!item) fail('item', 'Say which item is free');
      terms.item = item;
      discountType = 'FREE_ITEM';
      break;
    case 'BUY_X_GET_Y': {
      const buy = cell('buy_quantity') || '1';
      const get = cell('get_quantity') || '1';
      if (!(whole(buy) && Number(buy) > 0)) fail('buy_quantity', 'At least 1');
      if (!(whole(get) && Number(get) > 0)) fail('get_quantity', 'At least 1');
      if (!item) fail('item', 'Say which item it applies to');
      terms.buyQuantity = Number(buy);
      terms.getQuantity = Number(get);
      terms.item = item;
      break;
    }
    case 'FREE_SHIPPING':
      setNumber('maxDiscountVnd', vnd('max_discount_vnd'));
      break;
    case 'FIXED_PRICE': {
      const price = vnd('price_vnd');
      if (!price) fail('price_vnd', 'Enter the special price');
      if (!item) fail('item', 'Say what the price is for');
      setNumber('priceVnd', price);
      terms.item = item;
      break;
    }
    case 'CUSTOM':
      if (!cell('benefit')) fail('benefit', 'Describe what the customer gets');
      terms.benefit = cell('benefit');
      break;
  }
  if (problems.length) return { code, problems };

  const description = cell('description');
  return {
    code,
    problems,
    item: {
      code,
      title,
      ...(description ? { description } : {}),
      pointsCost: Number(points),
      ...(discountType ? { discountType } : {}),
      ...(discountValue ? { discountValue } : {}),
      terms,
      totalSupply,
      perMemberLimit,
      startsAt: opens ? new Date(`${opens}T00:00:00${offset}`).toISOString() : null,
      expiresAt: closes ? new Date(`${closes}T23:59:59${offset}`).toISOString() : null,
      validForDays: days ? Number(days) : null,
    },
  };
}

/**
 * A date cell as `YYYY-MM-DD`. Excel rewrites dates in the computer's own format when it saves a
 * CSV (`12/31/2027` on a US Mac, `31/12/2027` in Vietnam), so `D/M/YYYY` and `M/D/YYYY` are read too
 * when only one of them is a real date. `05/02/2027` could be 5 February or 2 May: refused.
 */
function csvDate(cell: string): { day: string } | { problem: string } {
  const pad = (n: number) => String(n).padStart(2, '0');
  const real = (y: number, m: number, d: number) => {
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  };
  const ok = (y: number, m: number, d: number) => (real(y, m, d) ? { day: `${y}-${pad(m)}-${pad(d)}` } : undefined);
  const unreadable = { problem: `"${cell}" is not a date; write it as YYYY-MM-DD, e.g. 2027-12-31` };
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(cell);
  if (iso) return ok(Number(iso[1]), Number(iso[2]), Number(iso[3])) ?? unreadable;
  const local = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(cell);
  if (!local) return unreadable;
  const [a, b, year] = [Number(local[1]), Number(local[2]), Number(local[3])];
  const dayFirst = ok(year, b, a);
  const monthFirst = ok(year, a, b);
  if (dayFirst && monthFirst && a !== b)
    return { problem: `"${cell}" could be ${dayFirst.day} or ${monthFirst.day}; write it as YYYY-MM-DD` };
  return dayFirst ?? monthFirst ?? unreadable;
}

/** RFC 4180 CSV: quoted fields may hold commas, quotes ("") and line breaks; a UTF-8 BOM is skipped. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim()));
}
