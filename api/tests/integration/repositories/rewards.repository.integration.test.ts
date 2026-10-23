import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { RewardsRepository } from '../../../src/infra/db/repositories/rewards.repository.js';
import { connectTestDb, resetDb, schema, seedMember, seedOrganization } from '../support/db.js';

const { db, client } = connectTestDb();
const repo = new RewardsRepository(db);

let orgId: string;
let memberId: string;

beforeEach(async () => {
  await resetDb(client);
  orgId = (await seedOrganization(db)).id;
  memberId = (await seedMember(db, orgId)).memberId;
});

afterAll(async () => {
  await client.end();
});

const createVoucher = (overrides: Partial<Parameters<RewardsRepository['createVoucher']>[0]> = {}) =>
  repo.createVoucher({ organizationId: orgId, code: 'FREESHIP', title: 'Free shipping', discountType: 'FREE_ITEM', ...overrides });
const voucherRow = async (id: string) => (await db.select().from(schema.vouchers).where(eq(schema.vouchers.id, id)))[0];

describe('RewardsRepository', () => {
  it('creates an ACTIVE voucher with defaults and finds it by id and per-org code', async () => {
    const voucher = await createVoucher({ discountValue: '10.50', totalSupply: 5, expiresAt: new Date('2030-01-01T00:00:00Z') });
    const other = await seedOrganization(db);

    expect(voucher).toMatchObject({ status: 'ACTIVE', claimedCount: 0, pointsCost: 0, discountValue: '10.50', metadata: {} });
    expect((await repo.findVoucherById(voucher.id))?.code).toBe('FREESHIP');
    expect((await repo.findVoucherByCode(orgId, 'FREESHIP'))?.id).toBe(voucher.id);
    expect(await repo.findVoucherByCode(other.id, 'FREESHIP')).toBeUndefined();
    expect((await repo.listVouchersByOrganization(orgId)).map((v) => v.id)).toEqual([voucher.id]);
  });

  it('the (organization, code) pair is unique', async () => {
    await createVoucher();
    await expect(createVoucher()).rejects.toThrow();
  });

  it('claims an instance, inheriting the voucher’s expiry, and counts the claim', async () => {
    const voucher = await createVoucher({ totalSupply: 10, expiresAt: new Date('2030-01-01T00:00:00Z') });

    const { ownership } = await repo.claimVoucherInstance({ voucherId: voucher.id, organizationEndUserId: memberId, serialCode: 'S-1' });

    expect(ownership).toMatchObject({ status: 'AVAILABLE', serialCode: 'S-1', expiresAt: new Date('2030-01-01T00:00:00Z') });
    expect(await voucherRow(voucher.id)).toMatchObject({ claimedCount: 1, status: 'ACTIVE' });
  });

  it('the last unit of supply depletes the voucher, and a further claim is refused', async () => {
    const voucher = await createVoucher({ totalSupply: 1 });
    const { memberId: second } = await seedMember(db, orgId);

    await repo.claimVoucherInstance({ voucherId: voucher.id, organizationEndUserId: memberId, serialCode: 'S-1' });
    expect((await voucherRow(voucher.id)).status).toBe('DEPLETED');

    await expect(repo.claimVoucherInstance({ voucherId: voucher.id, organizationEndUserId: second, serialCode: 'S-2' })).rejects.toThrow(
      /not active \(current status: DEPLETED\)/,
    );
  });

  it('refuses an exhausted supply even while still ACTIVE', async () => {
    const voucher = await createVoucher({ totalSupply: 1 });
    await db.update(schema.vouchers).set({ claimedCount: 1 }).where(eq(schema.vouchers.id, voucher.id));

    await expect(repo.claimVoucherInstance({ voucherId: voucher.id, organizationEndUserId: memberId, serialCode: 'S' })).rejects.toThrow(
      /completely depleted/,
    );
  });

  it('refuses a second claim by the same member, a missing voucher, and an inactive one', async () => {
    const voucher = await createVoucher();
    await repo.claimVoucherInstance({ voucherId: voucher.id, organizationEndUserId: memberId, serialCode: 'S-1' });

    await expect(repo.claimVoucherInstance({ voucherId: voucher.id, organizationEndUserId: memberId, serialCode: 'S-2' })).rejects.toThrow(
      /already been claimed by this member/,
    );
    await expect(
      repo.claimVoucherInstance({ voucherId: '00000000-0000-0000-0000-000000000000', organizationEndUserId: memberId, serialCode: 'S-3' }),
    ).rejects.toThrow(/Voucher not found/);

    const paused = await createVoucher({ code: 'PAUSED' });
    await db.update(schema.vouchers).set({ status: 'PAUSED' }).where(eq(schema.vouchers.id, paused.id));
    await expect(repo.claimVoucherInstance({ voucherId: paused.id, organizationEndUserId: memberId, serialCode: 'S-4' })).rejects.toThrow(
      /current status: PAUSED/,
    );
  });

  it('finds an instance by serial with its voucher, redeems it, and lists a member’s instances', async () => {
    const voucher = await createVoucher();
    const { ownership } = await repo.claimVoucherInstance({
      voucherId: voucher.id,
      organizationEndUserId: memberId,
      serialCode: 'S-1',
      expiresAt: new Date('2031-01-01T00:00:00Z'),
    });

    const found = await repo.findOwnershipBySerial('S-1');
    expect(found?.voucher.id).toBe(voucher.id);
    expect(found?.expiresAt).toEqual(new Date('2031-01-01T00:00:00Z'));

    const redeemed = await repo.markVoucherRedeemed(ownership.id);
    expect(redeemed.status).toBe('REDEEMED');
    expect(redeemed.redeemedAt).toBeInstanceOf(Date);

    const listed = await repo.listOwnershipsByMember(memberId);
    expect(listed.map((o) => [o.serialCode, o.voucher.code])).toEqual([['S-1', 'FREESHIP']]);
    expect(await repo.findOwnershipBySerial('missing')).toBeUndefined();
  });
});
