import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { UnauthorizedException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { OrganizationStreamEvent } from '@octap/contracts';

// Read when the stream modules load: a fast scan and heartbeat keep these tests short.
vi.hoisted(() => {
  process.env.CONSOLE_EVENTS_POLL_INTERVAL_MS = '100';
  process.env.CONSOLE_EVENTS_HEARTBEAT_MS = '300';
});

import { createTestApp } from '../support/app.js';
import { resetDb, schema, seedCredential, seedOrganization, seedProgram } from '../support/db.js';

const ACTORS = ['owner', 'developer', 'staff', 'outsider'] as const;
type Actor = (typeof ACTORS)[number];

interface Frame {
  event: string;
  id?: string;
  data: string;
}

/** A console stream read over real HTTP, as a `fetch`-based SSE client reads it. */
class Stream {
  private buffer = '';
  private readonly frames: Frame[] = [];
  private done = false;
  private constructor(
    readonly status: number,
    private readonly reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
    private readonly abort: AbortController,
  ) {
    void this.pump();
  }

  static async open(url: string, headers: Record<string, string>) {
    const abort = new AbortController();
    const response = await fetch(url, { headers, signal: abort.signal });
    const stream = new Stream(response.status, response.ok ? response.body!.getReader() : undefined, abort);
    return { stream, response };
  }

  private async pump() {
    if (!this.reader) return;
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        this.buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = this.buffer.indexOf('\n\n')) >= 0) {
          const raw = this.buffer.slice(0, end);
          this.buffer = this.buffer.slice(end + 2);
          if (raw.startsWith(':') || raw.startsWith('retry:')) continue;
          const field = (name: string) => new RegExp(`^${name}: (.*)$`, 'm').exec(raw)?.[1];
          this.frames.push({ event: field('event') ?? 'message', id: field('id'), data: field('data') ?? '' });
        }
      }
    } catch {
      // Aborted by the test.
    }
    this.done = true;
  }

  /** Waits for a frame of `event`, then returns every frame so far. */
  async waitFor(event: string, timeoutMs = 5_000): Promise<Frame[]> {
    const until = Date.now() + timeoutMs;
    while (!this.frames.some((f) => f.event === event)) {
      if (Date.now() > until) throw new Error(`no ${event} within ${timeoutMs}ms; got ${this.names().join(', ')}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return [...this.frames];
  }

  async waitForEnd(timeoutMs = 5_000) {
    const until = Date.now() + timeoutMs;
    while (!this.done) {
      if (Date.now() > until) throw new Error('the stream did not close');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  names() {
    return this.frames.map((f) => f.event);
  }

  events(): OrganizationStreamEvent[] {
    return this.frames.filter((f) => f.id !== undefined).map((f) => JSON.parse(f.data) as OrganizationStreamEvent);
  }

  close() {
    this.abort.abort();
  }
}

describe('console event stream over HTTP (OCT-326)', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let base: string;
  let ids: Record<Actor, string>;
  let orgId: string;
  let key: { Authorization: string };
  const open: Stream[] = [];
  const google = {
    verify: async (token: string) => {
      if (!(ACTORS as readonly string[]).includes(token)) throw new UnauthorizedException();
      return {
        subject: token,
        email: `${token}@example.com`,
        fullName: token,
        avatarUrl: null,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };
    },
  };
  const connect = async (actor: Actor, headers: Record<string, string> = {}, org = orgId) => {
    const { stream } = await Stream.open(`${base}/v1/console/organizations/${org}/events`, {
      Authorization: `Bearer ${actor}`,
      ...headers,
    });
    open.push(stream);
    return stream;
  };
  const createVoucher = async (code: string) =>
    (
      await ctx
        .http()
        .post('/v1/rewards/vouchers')
        .set(key)
        .send({ code, title: code, discountType: 'FREE_ITEM', pointsCost: 10, status: 'DRAFT' })
        .expect(201)
    ).body as { id: string };

  beforeAll(async () => {
    ctx = await createTestApp(undefined, google);
    const server = ctx.app.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await ctx?.close();
  });
  beforeEach(async () => {
    await resetDb(ctx.db);
    ids = {} as Record<Actor, string>;
    for (const actor of ACTORS) {
      ids[actor] = (await ctx.http().post('/v1/console/auth/google').send({ idToken: actor }).expect(201)).body.user.id;
    }
    orgId = (await seedOrganization(ctx.db)).id;
    const otherOrg = (await seedOrganization(ctx.db)).id;
    await seedProgram(ctx.db, orgId);
    await ctx.db.insert(schema.organizationMemberships).values([
      { organizationId: orgId, systemUserId: ids.owner, role: 'OWNER' },
      { organizationId: orgId, systemUserId: ids.developer, role: 'BUSINESS_DEVELOPER' },
      { organizationId: orgId, systemUserId: ids.staff, role: 'STAFF' },
      { organizationId: otherOrg, systemUserId: ids.outsider, role: 'OWNER' },
    ]);
    key = { Authorization: `Bearer ${(await seedCredential(ctx.db, orgId, { scopes: ['read', 'write'] })).rawKey}` };
  });
  afterEach(() => {
    for (const stream of open.splice(0)) stream.close();
  });

  it('refuses anyone but an active Owner or Business Developer, before streaming anything', async () => {
    const url = `${base}/v1/console/organizations/${orgId}/events`;
    expect((await Stream.open(url, {})).response.status).toBe(401);
    expect((await Stream.open(url, key)).response.status).toBe(401);
    for (const actor of ['staff', 'outsider'] as const) {
      const { response } = await Stream.open(url, { Authorization: `Bearer ${actor}` });
      expect(response.status).toBe(403);
      expect(response.headers.get('content-type')).toMatch(/application\/json/);
    }
  });

  it('streams what happens as it happens, to the Owner and a Business Developer alike', async () => {
    const owner = await connect('owner');
    const developer = await connect('developer');
    // Let both streams join before the change.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const { id } = await createVoucher('LIVE');

    for (const stream of [owner, developer]) {
      await stream.waitFor('voucher.created');
      expect(stream.events()).toMatchObject([
        { type: 'voucher.created', subject: { kind: 'voucher', id, batchId: null }, sequence: expect.any(Number) },
      ]);
    }
    // Thin: the stream names what changed, the REST route says what it is now.
    expect(Object.keys(owner.events()[0]).sort()).toEqual(['id', 'occurredAt', 'sequence', 'subject', 'type']);
  });

  it('a reconnect with Last-Event-ID replays what it missed; an unknown one says stream.reset', async () => {
    const first = await createVoucher('FIRST');
    const [seen] = await ctx.db
      .select()
      .from(schema.organizationEvents)
      .where(eq(schema.organizationEvents.organizationId, orgId));
    const second = await createVoucher('SECOND');

    const resumed = await connect('owner', { 'Last-Event-ID': String(seen.sequence) });
    await resumed.waitFor('voucher.created');
    expect(resumed.events().map((e) => e.subject)).toEqual([{ kind: 'voucher', id: second.id, batchId: null }]);
    expect(first.id).not.toBe(second.id);

    const unknown = await connect('owner', { 'Last-Event-ID': '999999999' });
    await unknown.waitFor('stream.reset');
  });

  it('never streams another organization’s events', async () => {
    const outsider = await connect(
      'outsider',
      {},
      (await ctx.db.select().from(schema.organizations)).find((o) => o.id !== orgId)!.id,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    await createVoucher('MINE');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(outsider.events()).toEqual([]);
  });

  it('closes with stream.access_revoked once the member loses access', async () => {
    const developer = await connect('developer');
    await new Promise((resolve) => setTimeout(resolve, 200));
    await ctx.db
      .update(schema.organizationMemberships)
      .set({ status: 'SUSPENDED' })
      .where(
        and(
          eq(schema.organizationMemberships.organizationId, orgId),
          eq(schema.organizationMemberships.systemUserId, ids.developer),
        ),
      );
    await developer.waitFor('stream.access_revoked');
    await developer.waitForEnd();
  });
});
