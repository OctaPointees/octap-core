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

  it('creates, finds by hash/id, lists newest-first, touches, and revokes', async () => {
    const first = await repo.create({
      organizationId: orgId,
      name: 'a',
      keyPrefix: 'octap_live_aaaa',
      keyHash: 'hash-a',
      scopes: ['read'],
    });
    const second = await repo.create({
      organizationId: orgId,
      name: 'b',
      keyPrefix: 'octap_live_bbbb',
      keyHash: 'hash-b',
      scopes: ['admin'],
      expiresAt: new Date('2030-01-01T00:00:00Z'),
    });

    expect(first).toMatchObject({ status: 'ACTIVE', lastUsedAt: null, scopes: ['read'] });
    expect((await repo.findByKeyHash('hash-b'))?.id).toBe(second.id);
    expect((await repo.findById(first.id))?.name).toBe('a');
    expect((await repo.listByOrganization(orgId)).map((c) => c.id)).toEqual([second.id, first.id]);

    await repo.touchLastUsed(first.id);
    expect((await repo.findById(first.id))?.lastUsedAt).toBeInstanceOf(Date);

    expect((await repo.revoke(first.id)).status).toBe('REVOKED');
    await expect(
      repo.create({ organizationId: orgId, name: 'dup', keyPrefix: 'p', keyHash: 'hash-a', scopes: [] }),
    ).rejects.toThrow();
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
