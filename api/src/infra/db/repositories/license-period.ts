import {
  LICENSE_EXPIRY_REMINDER_DAYS,
  LICENSE_GRACE_DAYS,
  type LicenseExpiryStage,
  type LicenseState,
} from '@octap/contracts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** When the grace period after `endsAt` is over. */
export const graceEndsAt = (endsAt: Date): Date => new Date(endsAt.getTime() + LICENSE_GRACE_DAYS * DAY_MS);

/** Worked out from the dates, so it is right at any moment without a job flipping a column. */
export function licenseState(endsAt: Date, now: Date): LicenseState {
  if (now < endsAt) return 'ACTIVE';
  return now < graceEndsAt(endsAt) ? 'GRACE' : 'EXPIRED';
}

/** Whole days until `endsAt`, counting a part day as a day; 0 once it has passed. */
export const daysLeft = (endsAt: Date, now: Date): number =>
  Math.max(0, Math.ceil((endsAt.getTime() - now.getTime()) / DAY_MS));

/**
 * `months` calendar months after `date`, in UTC, keeping the time of day. A day the target month
 * doesn't have becomes its last day: 31 January plus one month is 28 (or 29) February, not 3 March.
 */
export function addMonths(date: Date, months: number): Date {
  const target = new Date(date.getTime());
  const day = date.getUTCDate();
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target;
}

export const addDays = (date: Date, days: number): Date => new Date(date.getTime() + days * DAY_MS);

/**
 * The license month `now` falls in: months are counted from `startsAt`, not from the calendar, so
 * a license started on the 15th resets its monthly usage on every 15th. The last month ends at
 * `endsAt` (a 14-day trial has one 14-day month), and once `endsAt` has passed it stays the last
 * month: a license in grace or expired doesn't roll new months forward.
 */
export function licensePeriod(startsAt: Date, endsAt: Date, now: Date): { start: Date; end: Date } {
  const at = now < endsAt ? now : new Date(endsAt.getTime() - 1);
  let months = (at.getUTCFullYear() - startsAt.getUTCFullYear()) * 12 + (at.getUTCMonth() - startsAt.getUTCMonth());
  if (months < 0) months = 0;
  while (months > 0 && addMonths(startsAt, months) > at) months -= 1;
  while (addMonths(startsAt, months + 1) <= at) months += 1;
  const end = addMonths(startsAt, months + 1);
  return { start: addMonths(startsAt, months), end: end < endsAt ? end : endsAt };
}

/**
 * The step of its end a license is at, or `null` before the first reminder. A reminder longer than
 * the license itself is skipped: a 14-day trial gets the 7-day and 1-day ones, not "30 days left" on
 * its first day.
 */
export function licenseExpiryStage(startsAt: Date, endsAt: Date, now: Date): LicenseExpiryStage | null {
  const state = licenseState(endsAt, now);
  if (state !== 'ACTIVE') return state;
  const left = endsAt.getTime() - now.getTime();
  const length = endsAt.getTime() - startsAt.getTime();
  for (const days of [...LICENSE_EXPIRY_REMINDER_DAYS].reverse()) {
    if (left <= days * DAY_MS && days * DAY_MS < length) return `DAYS_${days}`;
  }
  return null;
}

/** Where a renewal starts: right after the current license while it still works, otherwise now. */
export function renewalStart(current: { endsAt: Date } | undefined, now: Date): Date {
  return current && licenseState(current.endsAt, now) !== 'EXPIRED' ? current.endsAt : now;
}
