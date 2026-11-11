import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { IdentityRepository } from '#infra/db/repositories/identity.repository.js';
import { ApiCredentialsRepository } from '#infra/db/repositories/api-credentials.repository.js';
import { ProgramsRepository } from '#infra/db/repositories/programs.repository.js';
import { connectTestDb, resetDb, schema, seedOrganization } from '../support/db.js';

const { db, client } = connectTestDb();

let orgId: string;

beforeEach(async () => {
  await resetDb(client);
  orgId = (await seedOrganization(db)).id;
});

afterAll(async () => {
  await client.end();
});

describe('IdentityRepository', () => {
  const repo = new IdentityRepository(db);

  it('creates end users keyed by a unique zkLogin address and enrolls them once per organization', async () => {
    const endUser = await repo.createEndUser({ suiAddress: '0xabc' });
    expect((await repo.findEndUserBySuiAddress('0xabc'))?.id).toBe(endUser.id);
    expect(await repo.findEndUserBySuiAddress('0xnope')).toBeUndefined();
    expect(await repo.createEndUser({ suiAddress: '0xabc' })).toBeUndefined();
    expect(await repo.findOrganizationStatus(orgId)).toBe('ACTIVE');
    expect(await repo.findOrganizationStatus('00000000-0000-0000-0000-000000000000')).toBeUndefined();

    const enrollment = await repo.enroll({ organizationId: orgId, endUserId: endUser.id });
    expect(enrollment).toMatchObject({
      organizationId: orgId,
      endUserId: endUser.id,
      tier: 'BRONZE',
    });
    expect((await repo.findEnrollment(orgId, endUser.id))?.id).toBe(enrollment.id);
    expect(await repo.enroll({ organizationId: orgId, endUserId: endUser.id })).toBeUndefined();

    const other = await seedOrganization(db);
    expect(await repo.findEnrollment(other.id, endUser.id)).toBeUndefined();

    const suspended = await seedOrganization(db, { status: 'SUSPENDED' });
    await expect(repo.enroll({ organizationId: suspended.id, endUserId: endUser.id })).rejects.toMatchObject({
      reason: 'ORGANIZATION_NOT_ACTIVE',
    });
    await db.update(schema.endUsers).set({ status: 'BLOCKED' }).where(eq(schema.endUsers.id, endUser.id));
    await expect(repo.enroll({ organizationId: other.id, endUserId: endUser.id })).rejects.toMatchObject({
      reason: 'CUSTOMER_NOT_ACTIVE',
    });
    expect(await repo.findEnrollment(other.id, endUser.id)).toBeUndefined();
  });
});

describe('ApiCredentialsRepository', () => {
  const repo = new ApiCredentialsRepository(db);
  const key = (name: string, keyHash: string, scopes: string[] = ['read']) => ({
    organizationId: orgId,
    name,
    keyPrefix: `octap_live_${name}`,
    keyHash,
    scopes,
  });
  const find = (id: string) => db.transaction((tx) => repo.findForUpdate(tx, id));

  it('creates, finds by hash and id, touches, renames and revokes', async () => {
    const first = (await repo.createWithinLimit(key('a', 'hash-a'), 25))!;
    const second = (await repo.createWithinLimit(key('b', 'hash-b', ['admin']), 25))!;

    expect(first).toMatchObject({ status: 'ACTIVE', lastUsedAt: null, scopes: ['read'] });
    expect((await repo.findByKeyHash('hash-b'))?.id).toBe(second.id);
    expect((await find(first.id))?.name).toBe('a');

    await repo.touchLastUsed(first.id);
    expect((await find(first.id))?.lastUsedAt).toBeInstanceOf(Date);

    expect((await db.transaction((tx) => repo.rename(tx, first.id, 'renamed'))).name).toBe('renamed');
    expect((await db.transaction((tx) => repo.revoke(tx, first.id))).status).toBe('REVOKED');
    await expect(repo.createWithinLimit(key('dup', 'hash-a'), 25)).rejects.toThrow();
  });

  it('stops at the ACTIVE limit, counting only ACTIVE keys', async () => {
    const revoked = (await repo.createWithinLimit(key('a', 'hash-a'), 2))!;
    await db.transaction((tx) => repo.revoke(tx, revoked.id));
    expect(await repo.createWithinLimit(key('b', 'hash-b'), 1)).toMatchObject({ status: 'ACTIVE' });
    expect(await repo.createWithinLimit(key('c', 'hash-c'), 1)).toBeUndefined();
    expect((await repo.createWithinLimit(key('d', 'hash-d'), 2))?.status).toBe('ACTIVE');
  });

  it('makes a second issue wait for an open one, then refuses it at the limit', async () => {
    await repo.createWithinLimit(key('a', 'hash-a'), 2);

    // The first issue takes the last slot and keeps its transaction open until the gate opens.
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => (openGate = resolve));
    let markInserted!: () => void;
    const inserted = new Promise<void>((resolve) => (markInserted = resolve));
    const first = db.transaction(async (tx) => {
      const created = await repo.createWithinLimit(key('b', 'hash-b'), 2, tx);
      markInserted();
      await gate;
      return created;
    });
    await inserted;

    let secondSettled = false;
    const second = repo.createWithinLimit(key('c', 'hash-c'), 2).finally(() => (secondSettled = true));
    // Wait until the second is blocked on a row lock, or has finished without waiting (no lock).
    let lockWaiters = 0;
    for (let i = 0; i < 100 && !secondSettled && lockWaiters === 0; i += 1) {
      const [row] = await db.execute<{ waiting: number }>(
        sql`select count(*)::int as waiting from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'`,
      );
      lockWaiters = row.waiting;
      if (lockWaiters === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(secondSettled).toBe(false);
    expect(lockWaiters).toBe(1);

    openGate();
    expect(await first).toMatchObject({ status: 'ACTIVE' });
    expect(await second).toBeUndefined();
    const active = await db
      .select()
      .from(schema.apiCredentials)
      .where(and(eq(schema.apiCredentials.organizationId, orgId), eq(schema.apiCredentials.status, 'ACTIVE')));
    expect(active).toHaveLength(2);
  });
});

describe('ProgramsRepository', () => {
  const repo = new ProgramsRepository(db);
  const reservation = () =>
    repo.reserve({
      organizationId: orgId,
      policyVersion: 1,
      earnBps: 100,
      expiryMs: 86_400_000,
      shardCount: 2,
      totalBudget: 1000,
    });

  it('reserves PROVISIONING, refuses a second reservation for the organization, activates, and releases', async () => {
    const reserved = await reservation();
    expect(reserved).toMatchObject({ status: 'PROVISIONING', programControlId: null, shardCount: 2 });
    await expect(reservation()).rejects.toMatchObject({ cause: { code: '23505' } });

    const activated = await repo.activate(reserved.id, {
      programControlId: '0xprogram',
      adminCapId: '0xadmin',
      policyVersionId: '0xpolicy',
      issuerCapId: '0xissuer',
      operationShardIds: ['0xop0', '0xop1'],
      budgetShardIds: ['0xb0', '0xb1'],
    });
    expect(activated).toMatchObject({ status: 'ACTIVE', operationShardIds: ['0xop0', '0xop1'] });
    expect((await repo.findByOrganization(orgId))?.id).toBe(reserved.id);

    await repo.release(reserved.id);
    expect(await db.select().from(schema.programs).where(eq(schema.programs.id, reserved.id))).toEqual([]);
    expect(await repo.findByOrganization(orgId)).toBeUndefined();
  });
});
