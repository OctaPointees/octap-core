import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
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
