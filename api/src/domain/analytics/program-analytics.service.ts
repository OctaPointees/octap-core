import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { ProgramAnalyticsDay, ProgramAnalyticsSummary } from '@octap/contracts';
import { ProgramAnalyticsRepository } from '#infra/db/repositories/program-analytics.repository.js';
import { ConsoleAccessError } from '#infra/db/repositories/console-access.js';
import { ConsoleOrganizationsRepository } from '#infra/db/repositories/console-organizations.repository.js';

/** ISO 8601 date-time with an explicit offset or Z, so the server's time zone never decides. */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const KEYS = ['from', 'to'];

/**
 * How an organization's points and vouchers actually moved, for its Owner and Business
 * Developers. See `ProgramAnalyticsSummary` in `@octap/contracts` for what each figure means and
 * why it's shown — nothing here is a raw count kept just because the data exists.
 */
@Injectable()
export class ProgramAnalyticsService {
  constructor(
    private readonly organizations: ConsoleOrganizationsRepository,
    private readonly analytics: ProgramAnalyticsRepository,
  ) {}

  async summaryAsMember(
    userId: string,
    organizationId: string,
    input: Record<string, unknown>,
  ): Promise<ProgramAnalyticsSummary> {
    const unknown = Object.keys(input).filter((key) => !KEYS.includes(key));
    if (unknown.length) throw new BadRequestException(`Unsupported query fields: ${unknown.join(', ')}`);
    const range = parseRange(input);

    let totals: Awaited<ReturnType<ProgramAnalyticsRepository['totals']>>;
    let enrolledMembers: number;
    let vouchers: Awaited<ReturnType<ProgramAnalyticsRepository['voucherTotals']>>;
    let dailyTrend: ProgramAnalyticsDay[];
    try {
      ({ totals, enrolledMembers, vouchers, dailyTrend } = await this.organizations.withAccess(
        userId,
        organizationId,
        false,
        async (tx) => ({
          totals: await this.analytics.totals(tx, organizationId, range),
          enrolledMembers: await this.analytics.enrolledMembers(tx, organizationId),
          vouchers: await this.analytics.voucherTotals(tx, organizationId, range),
          dailyTrend: (await this.analytics.dailyTrend(tx, organizationId, range)).map((day) => ({
            start: day.start.toISOString(),
            earned: day.earned,
            redeemed: day.redeemed,
          })),
        }),
      ));
    } catch (error) {
      if (error instanceof ConsoleAccessError) throw new ForbiddenException('Organization access is required');
      throw error;
    }

    return {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      circulation: {
        earned: totals.earned,
        redeemed: totals.redeemed,
        reversed: totals.reversed,
        net: totals.earned - totals.redeemed - totals.reversed,
      },
      engagement: { activeMembers: totals.activeMembers, enrolledMembers },
      vouchers,
      dailyTrend,
    };
  }
}

function parseRange(input: Record<string, unknown>): { from: Date; to: Date } {
  const to = input.to === undefined ? new Date() : parseIso(input.to, 'to');
  const from = input.from === undefined ? new Date(to.getTime() - DEFAULT_WINDOW_MS) : parseIso(input.from, 'from');
  if (from >= to) throw new BadRequestException('from must be before to');
  return { from, to };
}

function parseIso(value: unknown, field: string): Date {
  const date = typeof value === 'string' && ISO_DATE_TIME.test(value) ? new Date(value) : new Date(NaN);
  if (Number.isNaN(date.getTime()))
    throw new BadRequestException(`${field} must be an ISO 8601 date-time with an offset or Z`);
  return date;
}
