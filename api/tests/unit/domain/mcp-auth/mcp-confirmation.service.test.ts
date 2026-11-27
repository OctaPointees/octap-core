import { describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { McpTokenIntrospection } from '@octap/contracts';
import { McpConfirmationService } from '#domain/mcp-auth/mcp-confirmation.service.js';

/** The three Redis commands the service uses, over a Map. TTLs are not modelled. */
function setup() {
  const store = new Map<string, string>();
  const redis = {
    set: vi.fn(async (key: string, value: string) => (store.set(key, value), 'OK')),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    getdel: vi.fn(async (key: string) => {
      const value = store.get(key) ?? null;
      store.delete(key);
      return value;
    }),
  };
  return { service: new McpConfirmationService(redis as unknown as Redis), store };
}

const ORG = '11111111-1111-4111-8111-111111111111';
const PATH = `/v1/console/organizations/${ORG}/vouchers`;
const token = (overrides: Partial<McpTokenIntrospection> = {}): McpTokenIntrospection => ({
  active: true,
  clientId: 'client-a',
  scopes: ['mcp', 'mcp:write'],
  userId: 'user-1',
  organizationId: ORG,
  persona: 'BUSINESS_OWNER',
  resource: 'http://localhost:4100/mcp',
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  ...overrides,
});
const change = { method: 'post', path: PATH, body: { code: 'A' }, summary: '  Create A  ' };

describe('McpConfirmationService (OCT-314)', () => {
  it('stores a change and reads it back for the same connection only', async () => {
    const { service, store } = setup();
    const prepared = await service.prepare(token(), ORG, change);
    expect(prepared).toMatchObject({ method: 'POST', path: PATH, body: { code: 'A' }, summary: 'Create A' });
    // Stored under a hash of the id, never the id itself.
    expect([...store.keys()].some((key) => key.includes(prepared.confirmationId))).toBe(false);

    expect(await service.get(token(), prepared.confirmationId)).toEqual(prepared);
    for (const other of [{ userId: 'user-2' }, { clientId: 'client-b' }, { organizationId: 'org-b' }])
      await expect(service.get(token(other), prepared.confirmationId)).rejects.toThrow('No pending change');
    await expect(service.get(token(), 'unknown')).rejects.toThrow('No pending change');
  });

  it('refuses a change that is not a write to a console route of this organization', async () => {
    const { service } = setup();
    const refused = [
      { ...change, method: 'GET' },
      { ...change, method: undefined },
      { ...change, path: '/v1/console/organizations/other/vouchers' },
      { ...change, path: `${PATH}/../../x` },
      { ...change, path: `${PATH}?x=1` },
      { ...change, path: 42 },
      { ...change, body: [] },
      { ...change, body: 'text' },
      { ...change, body: { big: 'x'.repeat(20_000) } },
      { ...change, summary: '   ' },
      { ...change, summary: 'x'.repeat(1001) },
    ];
    for (const input of refused) await expect(service.prepare(token(), ORG, input)).rejects.toThrow();
    await expect(service.prepare(token(), ORG, null)).rejects.toThrow('method must be');
    // No body is an empty one.
    expect((await service.prepare(token(), ORG, { ...change, body: undefined })).body).toEqual({});
  });

  it('applies a confirmation once, for exactly its request, and replays the stored answer', async () => {
    const { service } = setup();
    const write = { method: 'POST', path: PATH, body: { code: 'A' } };
    const { confirmationId } = await service.prepare(token(), ORG, change);

    expect(await service.consume(token(), write, confirmationId)).toEqual({ kind: 'apply', id: confirmationId });
    // Used, and no answer kept yet: a racing second request is refused.
    await expect(service.consume(token(), write, confirmationId)).rejects.toThrow('already made');

    await service.storeResult(token(), write, confirmationId, { id: 'voucher-1' });
    expect(await service.consume(token(), write, confirmationId)).toEqual({
      kind: 'replay',
      body: { id: 'voucher-1' },
    });
    // The answer is replayed only for the same connection and the same request.
    await expect(service.consume(token({ clientId: 'client-b' }), write, confirmationId)).rejects.toThrow(
      'already made',
    );
    await expect(service.consume(token(), { ...write, body: { code: 'B' } }, confirmationId)).rejects.toThrow(
      'already made',
    );
    await service.storeResult(token(), { ...write, body: undefined }, 'other', undefined);
    expect(await service.consume(token(), { ...write, body: {} }, 'other')).toEqual({ kind: 'replay', body: null });
  });

  it('burns a confirmation used by another connection or for another request', async () => {
    const { service } = setup();
    const write = { method: 'POST', path: PATH, body: { code: 'A' } };

    const stolen = (await service.prepare(token(), ORG, change)).confirmationId;
    await expect(service.consume(token({ userId: 'user-2' }), write, stolen)).rejects.toThrow('another connection');
    await expect(service.consume(token(), write, stolen)).rejects.toThrow('already made');

    for (const altered of [
      { ...write, method: 'PATCH' },
      { ...write, path: `${PATH}/x` },
      { ...write, body: { code: 'A', extra: 1 } },
    ]) {
      const id = (await service.prepare(token(), ORG, change)).confirmationId;
      await expect(service.consume(token(), altered, id)).rejects.toThrow('not the change that was confirmed');
      await expect(service.consume(token(), write, id)).rejects.toThrow('already made');
    }
  });
});
