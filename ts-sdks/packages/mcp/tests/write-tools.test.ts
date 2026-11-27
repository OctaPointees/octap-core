import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { OctaApiError, type VoucherDto } from '@octap/sdk';
import type { PreparedChange } from '../src/console-client.js';
import { toolsForPersona } from '../src/personas.js';
import { createServer, type ChangeInput, type ConsoleWrites, type CoreClientLike } from '../src/server.js';

const ORG = '/v1/console/organizations/org-a';
const VOUCHER_ID = '11111111-1111-4111-8111-111111111111';

const voucher = (overrides: Partial<VoucherDto> = {}) =>
  ({
    id: VOUCHER_ID,
    organizationId: 'org-a',
    code: 'COFFEE',
    title: 'Free coffee',
    pointsCost: 100,
    publishStatus: 'NOT_PUBLISHED',
    perMemberLimit: null,
    claimedCount: 0,
    status: 'DRAFT',
    validForDays: null,
    createdBy: null,
    activatedBy: null,
    activatedAt: null,
    createdAt: '2026-11-27T00:00:00.000Z',
    updatedAt: '2026-11-27T00:00:00.000Z',
    ...overrides,
  }) as VoucherDto;

/** A fake Core: prepared changes are kept by id, and applying one returns `answer`. */
function fakeCore(current = voucher(), answer: unknown = voucher()) {
  const prepared = new Map<string, PreparedChange>();
  const writes = {
    voucherPath: (id?: string) => `${ORG}/vouchers${id ? `/${id}` : ''}`,
    consoleVoucher: vi.fn(async () => current),
    prepareChange: vi.fn(async (change: ChangeInput) => {
      const confirmation = { ...change, confirmationId: `c${prepared.size + 1}`, expiresAt: '2026-11-27T00:05:00Z' };
      prepared.set(confirmation.confirmationId, confirmation);
      return confirmation;
    }),
    getChange: vi.fn(async (id: string) => {
      const change = prepared.get(id);
      if (!change) throw new OctaApiError(404, 'Not Found', { message: 'No pending change' });
      return change;
    }),
    applyChange: vi.fn(async (): Promise<unknown> => answer),
  } satisfies ConsoleWrites;
  const client = {
    getBalance: vi.fn(),
    listTransactions: vi.fn(),
    listMemberVouchers: vi.fn(),
    ...writes,
  } as unknown as CoreClientLike;
  return { client, writes };
}

async function connect(client: CoreClientLike, persona: string, canWrite: boolean) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ client, tools: toolsForPersona(persona, canWrite) });
  const mcp = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  return mcp;
}

describe('MCP write tools (OCT-314)', () => {
  it('offers none without mcp:write, even to a client that could serve them', async () => {
    const mcp = await connect(fakeCore().client, 'BUSINESS_OWNER', false);
    const names = (await mcp.listTools()).tools.map((tool) => tool.name);
    expect(names).not.toContain('create_voucher');
    expect(names).not.toContain('confirm_change');
  });

  it('prepares a change without making it, then makes it on confirm_change', async () => {
    const { client, writes } = fakeCore();
    const mcp = await connect(client, 'BUSINESS_OWNER', true);
    const tools = (await mcp.listTools()).tools;
    // Preparing changes nothing; confirming is the write, so a host asks the user first.
    expect(tools.find((tool) => tool.name === 'create_voucher')?.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools.find((tool) => tool.name === 'confirm_change')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });

    const prepared = await mcp.callTool({
      name: 'create_voucher',
      arguments: {
        code: 'COFFEE',
        title: 'Free coffee',
        pointsCost: 100,
        discountType: 'FREE_ITEM',
        totalSupply: null,
      },
    });
    expect(prepared.isError).toBeFalsy();
    expect(prepared.structuredContent).toMatchObject({
      confirmationId: 'c1',
      summary: expect.stringContaining('points cost: 100; discount type: FREE_ITEM; total supply: none (no limit)'),
    });
    expect(writes.prepareChange).toHaveBeenCalledWith(
      {
        method: 'POST',
        path: `${ORG}/vouchers`,
        body: {
          code: 'COFFEE',
          title: 'Free coffee',
          pointsCost: 100,
          discountType: 'FREE_ITEM',
          totalSupply: null,
          status: 'DRAFT',
        },
        summary: expect.any(String),
      },
      expect.anything(),
    );
    expect(writes.applyChange).not.toHaveBeenCalled();

    const applied = await mcp.callTool({ name: 'confirm_change', arguments: { confirmationId: 'c1' } });
    expect(applied.structuredContent).toMatchObject({
      done: true,
      voucher: { voucherId: VOUCHER_ID, status: 'DRAFT' },
    });
    expect(writes.applyChange).toHaveBeenCalledWith(
      expect.objectContaining({ confirmationId: 'c1', method: 'POST' }),
      expect.anything(),
    );
  });

  it('approves the submission the Owner saw, and refuses a voucher not waiting for approval', async () => {
    const waiting = voucher({
      status: 'PENDING_APPROVAL',
      approval: { id: 'submission-1', status: 'PENDING' } as VoucherDto['approval'],
    });
    const { client, writes } = fakeCore(waiting);
    const mcp = await connect(client, 'BUSINESS_OWNER', true);
    await mcp.callTool({ name: 'approve_voucher', arguments: { voucherId: VOUCHER_ID } });
    expect(writes.prepareChange).toHaveBeenCalledWith(
      expect.objectContaining({
        path: `${ORG}/vouchers/${VOUCHER_ID}/approve`,
        body: { approvalRequestId: 'submission-1' },
      }),
      expect.anything(),
    );

    const draft = await connect(fakeCore(voucher()).client, 'BUSINESS_OWNER', true);
    const refused = await draft.callTool({ name: 'approve_voucher', arguments: { voucherId: VOUCHER_ID } });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain('not waiting for approval');
  });

  it("passes Core's reason on when it refuses a change, and offers a Developer no Owner decision", async () => {
    const { client, writes } = fakeCore();
    writes.applyChange.mockRejectedValueOnce(
      new OctaApiError(403, 'Forbidden', { message: 'Only the Owner can approve vouchers' }),
    );
    const mcp = await connect(client, 'BUSINESS_DEVELOPER', true);
    const names = (await mcp.listTools()).tools.map((tool) => tool.name);
    expect(names).not.toContain('approve_voucher');
    expect(names).toContain('submit_voucher');

    await mcp.callTool({ name: 'submit_voucher', arguments: { voucherId: VOUCHER_ID } });
    const refused = await mcp.callTool({ name: 'confirm_change', arguments: { confirmationId: 'c1' } });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain('Only the Owner can approve vouchers');

    const unknown = await mcp.callTool({ name: 'confirm_change', arguments: { confirmationId: 'nope' } });
    expect(JSON.stringify(unknown.content)).toContain('prepare it again');
  });

  it('prepares each voucher change against the right route, with a summary naming the voucher', async () => {
    const paused = voucher({ status: 'PAUSED' });
    const { client, writes } = fakeCore(paused);
    const owner = await connect(client, 'BUSINESS_OWNER', true);
    const call = async (name: string, args: Record<string, unknown>) => {
      const answer = await owner.callTool({ name, arguments: { voucherId: VOUCHER_ID, ...args } });
      expect(answer.isError).toBeFalsy();
      return vi.mocked(writes.prepareChange).mock.calls.at(-1)![0];
    };

    expect(
      await call('update_voucher', { changes: { title: 'Latte', perMemberLimit: 2, startsAt: undefined } }),
    ).toMatchObject({
      method: 'PATCH',
      path: `${ORG}/vouchers/${VOUCHER_ID}`,
      body: { title: 'Latte', perMemberLimit: 2 },
      summary: expect.stringContaining('"Free coffee" (COFFEE, now PAUSED): title: Latte; limit per member: 2'),
    });
    expect(await call('withdraw_voucher', {})).toMatchObject({
      path: `${ORG}/vouchers/${VOUCHER_ID}/withdraw`,
      body: {},
    });
    expect(await call('activate_voucher', {})).toMatchObject({
      body: { status: 'ACTIVE' },
      summary: expect.stringContaining('Resume voucher'),
    });
    expect(await call('pause_voucher', {})).toMatchObject({ method: 'PATCH', body: { status: 'PAUSED' } });

    const draft = fakeCore(voucher());
    const fresh = await connect(draft.client, 'BUSINESS_OWNER', true);
    await fresh.callTool({ name: 'activate_voucher', arguments: { voucherId: VOUCHER_ID } });
    expect(vi.mocked(draft.writes.prepareChange).mock.calls[0][0].summary).toContain('published on-chain');
  });

  it('rejects with the reason, and refuses empty updates and bad amounts before asking Core', async () => {
    const waiting = voucher({
      status: 'PENDING_APPROVAL',
      approval: { id: 'submission-1', status: 'PENDING' } as VoucherDto['approval'],
    });
    const { client, writes } = fakeCore(waiting);
    const mcp = await connect(client, 'BUSINESS_OWNER', true);
    await mcp.callTool({ name: 'reject_voucher', arguments: { voucherId: VOUCHER_ID, reason: 'Too cheap' } });
    expect(vi.mocked(writes.prepareChange).mock.calls[0][0]).toMatchObject({
      path: `${ORG}/vouchers/${VOUCHER_ID}/reject`,
      body: { approvalRequestId: 'submission-1', reason: 'Too cheap' },
    });

    const empty = await mcp.callTool({ name: 'update_voucher', arguments: { voucherId: VOUCHER_ID, changes: {} } });
    expect(empty.isError).toBe(true);
    const amount = await mcp.callTool({
      name: 'create_voucher',
      arguments: { code: 'A', title: 'A', pointsCost: 1, discountType: 'PERCENTAGE', discountValue: 'ten' },
    });
    expect(amount.isError).toBe(true);
    expect(writes.prepareChange).toHaveBeenCalledTimes(1);
  });

  it.each([
    [400, { message: ['expiresAt is too soon'] }, 'Core refused this change: expiresAt is too soon'],
    [409, null, 'Core refused this change.'],
    [401, null, 'sign in again'],
    [403, null, 'may not do this'],
    [404, null, 'prepare it again'],
    [429, null, 'Rate limited'],
    [503, null, 'temporarily unavailable'],
  ])('explains a %i from Core without leaking anything else', async (status, body, message) => {
    const { client, writes } = fakeCore();
    vi.mocked(writes.prepareChange).mockRejectedValueOnce(new OctaApiError(status, 'x', body));
    const mcp = await connect(client, 'BUSINESS_OWNER', true);
    const answer = await mcp.callTool({ name: 'withdraw_voucher', arguments: { voucherId: VOUCHER_ID } });
    expect(answer.isError).toBe(true);
    expect(JSON.stringify(answer.content)).toContain(message);
  });

  it('hides an unexpected failure, and returns no voucher for an answer that is not one', async () => {
    const { client, writes } = fakeCore(voucher(), { updated: true });
    vi.mocked(writes.consoleVoucher).mockRejectedValueOnce(new Error('socket hang up at 10.0.0.1'));
    const mcp = await connect(client, 'BUSINESS_OWNER', true);
    const failed = await mcp.callTool({ name: 'pause_voucher', arguments: { voucherId: VOUCHER_ID } });
    expect(JSON.stringify(failed.content)).toContain('could not complete this change');
    expect(JSON.stringify(failed.content)).not.toContain('10.0.0.1');

    await mcp.callTool({ name: 'pause_voucher', arguments: { voucherId: VOUCHER_ID } });
    const applied = await mcp.callTool({ name: 'confirm_change', arguments: { confirmationId: 'c1' } });
    expect(applied.structuredContent).toMatchObject({ done: true, voucher: null });
  });
});
