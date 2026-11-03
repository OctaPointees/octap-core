import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { ConsoleOperatorRepository } from '#infra/db/repositories/console-operator.repository.js';
import { createTestApp } from './support/app.js';
import { resetDb, schema } from './support/db.js';

describe('operator-only console provisioning', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let repository: ConsoleOperatorRepository;
  const identity = {
    subject: 'verified-subject',
    email: 'operator@example.com',
    fullName: 'Operator',
    avatarUrl: null,
    expiresAt: 9999999999,
  };
  beforeAll(async () => {
    ctx = await createTestApp();
    repository = new ConsoleOperatorRepository(ctx.db);
  });
  afterAll(async () => {
    await ctx?.close();
  });
  beforeEach(async () => {
    await resetDb(ctx.db);
  });
  it('creates the first admin and records exact before/after without any token', async () => {
    const audit = vi.fn();
    const result = await repository.execute({ action: 'bootstrap-admin' }, identity, audit);
    expect(result.before).toBeNull();
    expect(result.after).toMatchObject({
      email: identity.email,
      googleSubject: identity.subject,
      systemRole: 'SYSTEM_ADMIN',
    });
    expect(audit).toHaveBeenCalledWith(result);
    await expect(repository.execute({ action: 'bootstrap-admin' }, identity, audit)).rejects.toThrow('already exists');
  });
  it('requires explicit legacy linking, preserves the role, and refuses mismatches and rebinding', async () => {
    const [user] = await ctx.db
      .insert(schema.systemUsers)
      .values({ email: identity.email, fullName: 'Legacy', systemRole: 'SYSTEM_ADMIN' })
      .returning();
    const audit = vi.fn();
    await expect(repository.execute({ action: 'link' }, identity, audit)).rejects.toThrow('explicit');
    await expect(
      repository.execute({ action: 'link', userId: user.id }, { ...identity, email: 'other@example.com' }, audit),
    ).rejects.toThrow('does not match');
    await expect(
      repository.execute({ action: 'link', userId: '00000000-0000-4000-8000-000000000000' }, identity, audit),
    ).rejects.toThrow('not found');
    const result = await repository.execute({ action: 'link', userId: user.id }, identity, audit);
    expect(result.before?.googleSubject).toBeNull();
    expect(result.after).toMatchObject({ id: user.id, systemRole: 'SYSTEM_ADMIN', googleSubject: identity.subject });
    await expect(
      repository.execute({ action: 'link', userId: user.id }, { ...identity, subject: 'another-subject' }, audit),
    ).rejects.toThrow('different Google');
  });
  it('promotes an existing verified user, but rolls back if recording the change fails', async () => {
    const [user] = await ctx.db
      .insert(schema.systemUsers)
      .values({ email: identity.email, fullName: identity.fullName, googleSubject: identity.subject })
      .returning();
    await expect(
      repository.execute({ action: 'bootstrap-admin' }, identity, () => {
        throw new Error('disk full');
      }),
    ).rejects.toThrow('disk full');
    expect((await ctx.db.query.systemUsers.findFirst({ where: eq(schema.systemUsers.id, user.id) }))?.systemRole).toBe(
      'SYSTEM_USER',
    );
    const result = await repository.execute({ action: 'bootstrap-admin' }, identity, () => {});
    expect(result.before?.systemRole).toBe('SYSTEM_USER');
    expect(result.after.systemRole).toBe('SYSTEM_ADMIN');
  });
  it('serializes competing initial administrators', async () => {
    const results = await Promise.allSettled([
      repository.execute({ action: 'bootstrap-admin' }, identity, () => {}),
      repository.execute(
        { action: 'bootstrap-admin' },
        { ...identity, subject: 'second', email: 'second@example.com' },
        () => {},
      ),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      await ctx.db.select().from(schema.systemUsers).where(eq(schema.systemUsers.systemRole, 'SYSTEM_ADMIN')),
    ).toHaveLength(1);
  });
  it('requires explicit selection for email collisions and never steals another subject', async () => {
    const [legacy] = await ctx.db
      .insert(schema.systemUsers)
      .values({ email: identity.email, fullName: 'Legacy' })
      .returning();
    await expect(repository.execute({ action: 'bootstrap-admin' }, identity, () => {})).rejects.toThrow('--user-id');
    const [other] = await ctx.db
      .insert(schema.systemUsers)
      .values({ email: 'other@example.com', fullName: 'Other', googleSubject: identity.subject })
      .returning();
    await expect(repository.execute({ action: 'link', userId: legacy.id }, identity, () => {})).rejects.toThrow(
      'another system user',
    );
    await ctx.db.delete(schema.systemUsers).where(eq(schema.systemUsers.id, other.id));
    const result = await repository.execute({ action: 'bootstrap-admin', userId: legacy.id }, identity, () => {});
    expect(result.after).toMatchObject({ id: legacy.id, systemRole: 'SYSTEM_ADMIN', googleSubject: identity.subject });
  });
});
