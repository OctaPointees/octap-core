import { describe, expect, it } from 'vitest';
import {
  addMonths,
  daysLeft,
  graceEndsAt,
  licensePeriod,
  licenseState,
} from '#infra/db/repositories/license-period.js';

const at = (iso: string) => new Date(iso);

describe('license state', () => {
  const endsAt = at('2026-12-01T00:00:00.000Z');

  it('is ACTIVE before ends_at, GRACE for 7 days after it, then EXPIRED', () => {
    expect(licenseState(endsAt, at('2026-11-30T23:59:59.999Z'))).toBe('ACTIVE');
    expect(licenseState(endsAt, endsAt)).toBe('GRACE');
    expect(graceEndsAt(endsAt).toISOString()).toBe('2026-12-08T00:00:00.000Z');
    expect(licenseState(endsAt, at('2026-12-07T23:59:59.999Z'))).toBe('GRACE');
    expect(licenseState(endsAt, at('2026-12-08T00:00:00.000Z'))).toBe('EXPIRED');
  });

  it('counts a part day as a day left, and nothing once ends_at has passed', () => {
    expect(daysLeft(endsAt, at('2026-11-29T00:00:00.000Z'))).toBe(2);
    expect(daysLeft(endsAt, at('2026-11-30T12:00:00.000Z'))).toBe(1);
    expect(daysLeft(endsAt, endsAt)).toBe(0);
    expect(daysLeft(endsAt, at('2026-12-05T00:00:00.000Z'))).toBe(0);
  });
});

describe('license months', () => {
  it('adds calendar months, keeping the time, and clamps to the last day of a shorter month', () => {
    expect(addMonths(at('2026-01-31T10:00:00.000Z'), 1).toISOString()).toBe('2026-02-28T10:00:00.000Z');
    expect(addMonths(at('2028-01-31T10:00:00.000Z'), 1).toISOString()).toBe('2028-02-29T10:00:00.000Z');
    expect(addMonths(at('2026-01-31T10:00:00.000Z'), 3).toISOString()).toBe('2026-04-30T10:00:00.000Z');
    expect(addMonths(at('2026-11-15T00:00:00.000Z'), 2).toISOString()).toBe('2027-01-15T00:00:00.000Z');
  });

  it('counts months from the start of the license, not the calendar month', () => {
    const startsAt = at('2026-01-15T08:00:00.000Z');
    const period = (now: string) => {
      const { start, end } = licensePeriod(startsAt, at('2028-01-15T08:00:00.000Z'), at(now));
      return [start.toISOString(), end.toISOString()];
    };
    expect(period('2026-01-15T08:00:00.000Z')).toEqual(['2026-01-15T08:00:00.000Z', '2026-02-15T08:00:00.000Z']);
    expect(period('2026-02-15T07:59:59.999Z')).toEqual(['2026-01-15T08:00:00.000Z', '2026-02-15T08:00:00.000Z']);
    expect(period('2026-02-15T08:00:00.000Z')).toEqual(['2026-02-15T08:00:00.000Z', '2026-03-15T08:00:00.000Z']);
    expect(period('2026-12-31T00:00:00.000Z')).toEqual(['2026-12-15T08:00:00.000Z', '2027-01-15T08:00:00.000Z']);
  });

  it('follows a license that started on the 31st through short months', () => {
    const { start, end } = licensePeriod(
      at('2026-01-31T00:00:00.000Z'),
      at('2027-01-31T00:00:00.000Z'),
      at('2026-03-01T00:00:00.000Z'),
    );
    expect([start.toISOString(), end.toISOString()]).toEqual(['2026-02-28T00:00:00.000Z', '2026-03-31T00:00:00.000Z']);
  });

  it('ends the last month at endsAt, and keeps it once the license has ended', () => {
    const startsAt = at('2026-01-01T00:00:00.000Z');
    const trialEnd = at('2026-01-15T00:00:00.000Z');
    const iso = ({ start, end }: { start: Date; end: Date }) => [start.toISOString(), end.toISOString()];
    expect(iso(licensePeriod(startsAt, trialEnd, at('2026-01-05T00:00:00.000Z')))).toEqual([
      '2026-01-01T00:00:00.000Z',
      '2026-01-15T00:00:00.000Z',
    ]);
    expect(iso(licensePeriod(startsAt, trialEnd, at('2026-03-01T00:00:00.000Z')))).toEqual([
      '2026-01-01T00:00:00.000Z',
      '2026-01-15T00:00:00.000Z',
    ]);
    const yearEnd = at('2027-01-01T00:00:00.000Z');
    expect(iso(licensePeriod(startsAt, yearEnd, at('2027-01-05T00:00:00.000Z')))).toEqual([
      '2026-12-01T00:00:00.000Z',
      '2027-01-01T00:00:00.000Z',
    ]);
  });
});
