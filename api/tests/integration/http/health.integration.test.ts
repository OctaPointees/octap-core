import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, fakeChainAdapters } from '../support/app.js';
import { resetDb, schema } from '../support/db.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('health and request tracing', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  const adapters = fakeChainAdapters();

  beforeAll(async () => {
    ctx = await createTestApp(adapters, {
      verify: async (subject: string) => ({
        subject,
        email: `${subject}@example.com`,
        fullName: subject,
        avatarUrl: null,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      }),
    });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await resetDb(ctx.db);
  });

  async function signIn(subject: string, admin: boolean) {
    const id = (await ctx.http().post('/v1/console/auth/google').send({ idToken: subject })).body.user.id;
    if (admin) {
      await ctx.db.update(schema.systemUsers).set({ systemRole: 'SYSTEM_ADMIN' }).where(eq(schema.systemUsers.id, id));
    }
    return `Bearer ${subject}`;
  }

  it('GET /health probes the real database and Redis without a credential, statuses only', async () => {
    const response = await ctx.http().get('/health').expect(200);

    expect(response.body).toEqual({
      status: 'ok',
      checkedAt: expect.any(String),
      checks: {
        database: { status: 'up', latencyMs: expect.any(Number) },
        redis: { status: 'up', latencyMs: expect.any(Number) },
        sui: { status: 'up', latencyMs: expect.any(Number) },
      },
    });
  });

  it('every response carries its own server-generated X-Request-Id, including errors and unknown routes', async () => {
    const health = await ctx.http().get('/health').set('X-Request-Id', 'planted');
    const unauthenticated = await ctx.http().get('/v1/credits/budget').expect(401);
    const missing = await ctx.http().get('/no-such-route').expect(404);

    const ids = [health, unauthenticated, missing].map((r) => r.headers['x-request-id']);
    for (const id of ids) expect(id).toMatch(UUID);
    expect(new Set(ids).size).toBe(3);
  });

  it('GET /v1/platform/health is for platform admins only', async () => {
    await ctx.http().get('/v1/platform/health').expect(401);
    const member = await signIn('member', false);
    await ctx.http().get('/v1/platform/health').set('Authorization', member).expect(403);
  });

  it('GET /v1/platform/health reports probe errors and worker lag from the database', async () => {
    const auth = await signIn('admin', true);
    await ctx.db.insert(schema.indexerCursors).values({
      streamName: 'octap::credit_account',
      cursor: 'C1',
      lastCheckpoint: '900',
      caughtUpCheckpoint: null,
    });
    adapters.suiBuilder.latestCheckpoint.mockRejectedValueOnce(new Error('fetch failed'));

    const degraded = await ctx.http().get('/v1/platform/health').set('Authorization', auth).expect(200);

    expect(degraded.body.status).toBe('degraded');
    expect(degraded.body.checks.sui).toMatchObject({ status: 'down', error: 'fetch failed' });
    expect(degraded.body.workerLag.indexer).toEqual([
      expect.objectContaining({ streamName: 'octap::credit_account', lastCheckpoint: '900', checkpointsBehind: null }),
    ]);

    const ok = await ctx.http().get('/v1/platform/health').set('Authorization', auth).expect(200);
    expect(ok.body.status).toBe('ok');
    expect(ok.body.workerLag).toMatchObject({
      operations: { oldestWorkerOwedAgeSeconds: null, byCommandType: [] },
      webhookDeliveries: { pending: 0, due: 0, oldestDueAgeSeconds: null, deadLettered: 0 },
      indexer: [expect.objectContaining({ chainCheckpoint: '1000', checkpointsBehind: '100' })],
    });
  });
});
