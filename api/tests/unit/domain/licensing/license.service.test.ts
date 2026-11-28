import { describe, expect, it, vi } from 'vitest';
import { LicenseService, checkEntitlements } from '#domain/licensing/license.service.js';
import type { ConsoleOrganizationsRepository } from '#infra/db/repositories/console-organizations.repository.js';
import type { LicensesRepository } from '#infra/db/repositories/licenses.repository.js';
import { stub } from '../../../helpers/stub.js';

const entitlements = {
  features: ['webhooks'],
  limits: { transactionsMonthly: 100, members: null, apiKeys: 2, teamMembers: 3 },
};

function service(repo: Partial<LicensesRepository> = {}) {
  const now = new Date('2026-11-26T00:00:00.000Z');
  const plan = {
    id: 'plan-1',
    tier: 'STARTER' as const,
    name: 'Starter',
    monthlyPriceVnd: 990_000,
    termMonthsAllowed: [3],
    durationDays: null,
    entitlements,
    purchasable: true,
    active: true,
    createdAt: now,
    updatedAt: now,
  };
  const licenses = stub<LicensesRepository>({
    createPlan: vi.fn(async (values) => ({ ...plan, ...values })),
    findPlan: vi.fn(async () => plan),
    updatePlan: vi.fn(async (_id, patch) => ({ ...plan, ...patch })),
    ...repo,
  });
  return { svc: new LicenseService(licenses, stub<ConsoleOrganizationsRepository>({})), licenses };
}

describe('LicenseService plan catalogue', () => {
  it('creates a plan with defaults and sorted terms', async () => {
    const { svc, licenses } = service();
    const plan = await svc.createPlan({
      tier: 'STARTER',
      name: '  Starter  ',
      monthlyPriceVnd: 990_000,
      termMonthsAllowed: [12, 3, 6],
      entitlements: entitlements as never,
    });
    expect(licenses.createPlan).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Starter', termMonthsAllowed: [3, 6, 12], purchasable: true, active: true }),
    );
    expect(plan.tier).toBe('STARTER');
  });

  it('refuses a plan it cannot sell or does not understand', async () => {
    const { svc } = service();
    const base = { tier: 'STARTER', name: 'S', monthlyPriceVnd: 1, termMonthsAllowed: [3], entitlements };
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ ...base, tier: 'GOLD' }, /tier must be one of/],
      [{ ...base, monthlyPriceVnd: -1 }, /monthlyPriceVnd/],
      [{ ...base, monthlyPriceVnd: 1.5 }, /monthlyPriceVnd/],
      [{ ...base, termMonthsAllowed: [3, 3] }, /termMonthsAllowed/],
      [{ ...base, termMonthsAllowed: [] }, /purchasable plan needs at least one term/],
      [{ ...base, durationDays: 0 }, /durationDays/],
      [{ ...base, discount: 10 }, /Unknown field: discount/],
      [{ ...base, purchasable: 'yes' }, /purchasable must be true or false/],
    ];
    for (const [body, message] of bad) await expect(svc.createPlan(body as never)).rejects.toThrow(message);
  });

  it('never changes a tier, and 404s an unknown plan', async () => {
    const { svc } = service({ findPlan: vi.fn(async () => undefined) });
    await expect(svc.updatePlan('plan-1', { tier: 'GROWTH' } as never)).rejects.toThrow(/tier can't change/);
    await expect(svc.updatePlan('plan-1', {})).rejects.toThrow(/at least one field/);
    await expect(svc.updatePlan('missing', { name: 'x' })).rejects.toMatchObject({ status: 404 });
  });
});

describe('checkEntitlements', () => {
  it('takes known features once and every limit as a positive whole number or null', () => {
    expect(checkEntitlements(entitlements)).toEqual(entitlements);
    const wrong: [unknown, RegExp][] = [
      [null, /features must list/],
      [{ ...entitlements, features: ['teleport'] }, /features must list/],
      [{ ...entitlements, features: ['mcp', 'mcp'] }, /features must list/],
      [{ ...entitlements, limits: [] }, /limits must be an object/],
      [{ ...entitlements, limits: { ...entitlements.limits, storage: 1 } }, /Unknown limit: storage/],
      [{ ...entitlements, limits: { ...entitlements.limits, apiKeys: 0 } }, /limits.apiKeys/],
      [{ features: [], limits: { transactionsMonthly: 1, members: 1, apiKeys: 1 } }, /limits.teamMembers/],
    ];
    for (const [value, message] of wrong) expect(() => checkEntitlements(value)).toThrow(message);
  });
});
