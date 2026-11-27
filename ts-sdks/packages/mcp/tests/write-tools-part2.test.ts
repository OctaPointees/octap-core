import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { VoucherBatchDetailDto, VoucherDto } from '@octap/sdk';
import type { PreparedChange } from '../src/console-client.js';
import { toolsForPersona } from '../src/personas.js';
import { createServer, type ChangeInput, type ConsoleReads, type CoreClientLike } from '../src/server.js';

const ORG = '/v1/console/organizations/org-a';
const BATCH = '22222222-2222-4222-8222-222222222222';
const MEMBER = '33333333-3333-4333-8333-333333333333';
const ENDPOINT = '44444444-4444-4444-8444-444444444444';
const DELIVERY = '55555555-5555-4555-8555-555555555555';

const voucher = (code: string, status: string): VoucherDto =>
  ({ id: `id-${code}`, code, title: code, status, updatedAt: `2026-11-27T00:00:0${code.length}.000Z` }) as VoucherDto;

/** A fake Core with the reads the write tools describe changes with. `answer` is what applying returns. */
function fakeCore(overrides: Partial<ConsoleReads> = {}, answer: unknown = {}) {
  const prepared = new Map<string, PreparedChange>();
  const reads: Partial<ConsoleReads> = {
    consoleVoucher: vi.fn(),
    consoleVouchers: vi.fn(async () => []),
    consoleVoucherBatch: vi.fn(
      async () =>
        ({
          id: BATCH,
          name: 'Tet 2027',
          vouchers: [voucher('A', 'DRAFT'), voucher('BB', 'ACTIVE'), voucher('CCC', 'PENDING_APPROVAL')],
        }) as unknown as VoucherBatchDetailDto,
    ),
    getMember: vi.fn(async () => ({ id: MEMBER, displayName: 'Lan', status: 'BLOCKED' }) as never),
    listApiKeys: vi.fn(async () => [
      {
        id: 'key-1',
        name: 'POS',
        keyPrefix: 'octap_live_ab12',
        scopes: ['read', 'write'],
        status: 'ACTIVE',
        createdAt: '',
        lastUsedAt: null,
      },
    ]),
    getRefundPolicy: vi.fn(async () => ({
      version: 3,
      allowUnused: true,
      allowExpired: false,
      allowRedeemed: false,
      restockUnused: true,
      refundWindowDays: null,
    })),
    getOrganization: vi.fn(async () => ({ id: 'org-a', name: 'A Coffee', slug: 'a' })),
    consoleWebhookEndpoints: vi.fn(async () => [{ id: ENDPOINT, url: 'https://hooks.example/octap?token=secret' }]),
    consoleWebhookDeliveries: vi.fn(async () => [{ id: DELIVERY, eventType: 'credits.earned', status: 'DEAD_LETTER' }]),
    ...overrides,
  };
  const writes = {
    organizationPath: (suffix = '') => `${ORG}${suffix}`,
    prepareChange: vi.fn(async (change: ChangeInput) => {
      const confirmation = { ...change, confirmationId: `c${prepared.size + 1}`, expiresAt: '2026-11-27T00:05:00Z' };
      prepared.set(confirmation.confirmationId, confirmation);
      return confirmation;
    }),
    getChange: vi.fn(async (id: string) => prepared.get(id)!),
    applyChange: vi.fn(async (): Promise<unknown> => answer),
  };
  const client = {
    getBalance: vi.fn(),
    listTransactions: vi.fn(),
    listMemberVouchers: vi.fn(),
    ...reads,
    ...writes,
  } as unknown as CoreClientLike;
  return { client, writes };
}

async function connect(client: CoreClientLike, persona = 'BUSINESS_OWNER') {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ client, tools: toolsForPersona(persona, true) });
  const mcp = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  return mcp;
}

/** Prepares `name` and returns what was sent to Core, or the tool's error text. */
async function prepared(
  mcp: Client,
  writes: ReturnType<typeof fakeCore>['writes'],
  name: string,
  args: object,
): Promise<Partial<ChangeInput> & { error?: string }> {
  const answer = await mcp.callTool({ name, arguments: args as Record<string, unknown> });
  if (answer.isError) return { error: JSON.stringify(answer.content) };
  return vi.mocked(writes.prepareChange).mock.calls.at(-1)![0];
}

describe('MCP write tools, part 2 (OCT-314)', () => {
  it('imports a batch and activates only its draft and waiting vouchers, as the user saw them', async () => {
    const { client, writes } = fakeCore();
    const mcp = await connect(client);
    const item = { code: 'TET10', title: '10% off', pointsCost: 100, discountType: 'PERCENTAGE', discountValue: '10' };
    expect(await prepared(mcp, writes, 'import_vouchers', { name: 'Tet', items: [item] })).toMatchObject({
      method: 'POST',
      path: `${ORG}/voucher-batches`,
      body: { name: 'Tet', items: [item] },
      summary: expect.stringContaining('Import 1 voucher as one draft batch "Tet": TET10 "10% off" (100 points)'),
    });

    expect(await prepared(mcp, writes, 'activate_voucher_batch', { batchId: BATCH })).toMatchObject({
      path: `${ORG}/voucher-batches/${BATCH}/activate`,
      body: {
        seen: [
          { voucherId: 'id-A', updatedAt: '2026-11-27T00:00:01.000Z' },
          { voucherId: 'id-CCC', updatedAt: '2026-11-27T00:00:03.000Z' },
        ],
      },
      summary: expect.stringContaining('Activate batch "Tet 2027": 2 vouchers (A, CCC)'),
    });
    for (const [tool, action] of [
      ['pause_voucher_batch', 'pause'],
      ['resume_voucher_batch', 'resume'],
      ['archive_voucher_batch', 'archive'],
    ])
      expect(await prepared(mcp, writes, tool, { batchId: BATCH })).toMatchObject({
        path: `${ORG}/voucher-batches/${BATCH}/${action}`,
        body: {},
      });

    const live = fakeCore({
      consoleVoucherBatch: vi.fn(async () => ({ id: BATCH, name: null, vouchers: [voucher('A', 'ACTIVE')] }) as never),
    });
    const nothing = await prepared(await connect(live.client), live.writes, 'activate_voucher_batch', {
      batchId: BATCH,
    });
    expect(nothing).toMatchObject({ error: expect.stringContaining('no draft or waiting voucher') });
  });

  it("reports each voucher's result after a batch change", async () => {
    const { client } = fakeCore(
      {},
      {
        items: [
          { index: 0, code: 'A', status: 'created' },
          { index: 1, code: null, status: 'error', error: { message: 'bad' } },
        ],
      },
    );
    const mcp = await connect(client);
    await mcp.callTool({
      name: 'import_vouchers',
      arguments: { items: [{ code: 'A', title: 'A', pointsCost: 1, discountType: 'FREE_ITEM' }] },
    });
    const applied = await mcp.callTool({ name: 'confirm_change', arguments: { confirmationId: 'c1' } });
    expect(applied.structuredContent).toMatchObject({
      voucher: null,
      outcomes: [
        { code: 'A', result: 'created', reason: null },
        { code: null, result: 'error', reason: 'bad' },
      ],
    });

    const action = fakeCore({}, { batch: {}, vouchers: [{ code: 'A', outcome: 'failed', reason: 'changed since' }] });
    const owner = await connect(action.client);
    await owner.callTool({ name: 'archive_voucher_batch', arguments: { batchId: BATCH } });
    const archived = await owner.callTool({ name: 'confirm_change', arguments: { confirmationId: 'c1' } });
    expect(archived.structuredContent).toMatchObject({
      outcomes: [{ code: 'A', result: 'failed', reason: 'changed since' }],
    });
  });

  it('changes members, and refuses to unblock one who is not blocked', async () => {
    const { client, writes } = fakeCore();
    const mcp = await connect(client);
    expect(
      await prepared(mcp, writes, 'update_member_details', {
        memberId: MEMBER,
        externalMemberId: 'POS-9',
        metadata: { tier: 'gold' },
      }),
    ).toMatchObject({
      method: 'PATCH',
      path: `${ORG}/members/${MEMBER}`,
      body: { externalMemberId: 'POS-9', metadata: { tier: 'gold' } },
      summary: 'Change member Lan (33333333…): POS id: POS-9; metadata: {"tier":"gold"}.',
    });
    expect(await prepared(mcp, writes, 'block_member', { memberId: MEMBER })).toMatchObject({
      body: { status: 'BLOCKED' },
    });
    expect(await prepared(mcp, writes, 'unblock_member', { memberId: MEMBER })).toMatchObject({
      body: { status: 'ACTIVE' },
    });

    const active = fakeCore({
      getMember: vi.fn(async () => ({ id: MEMBER, displayName: null, status: 'ACTIVE' }) as never),
    });
    expect(
      await prepared(await connect(active.client), active.writes, 'unblock_member', { memberId: MEMBER }),
    ).toMatchObject({
      error: expect.stringContaining('not BLOCKED'),
    });
    expect(await prepared(mcp, writes, 'update_member_details', { memberId: MEMBER })).toHaveProperty('error');
  });

  it('renames and revokes an API key found by its prefix, never creating one', async () => {
    const { client, writes } = fakeCore();
    const mcp = await connect(client);
    expect(
      await prepared(mcp, writes, 'rename_api_key', { keyPrefix: 'octap_live_ab12', name: 'Till 2' }),
    ).toMatchObject({
      method: 'PATCH',
      path: `${ORG}/api-credentials/key-1`,
      body: { name: 'Till 2' },
      summary: 'Rename API key octap_live_ab12… from "POS" to "Till 2".',
    });
    expect(await prepared(mcp, writes, 'revoke_api_key', { keyPrefix: 'octap_live_ab12' })).toMatchObject({
      method: 'DELETE',
      summary: expect.stringContaining('read and write): every system using it stops working at once'),
    });
    expect(await prepared(mcp, writes, 'revoke_api_key', { keyPrefix: 'octap_live_zz99' })).toMatchObject({
      error: expect.stringContaining('No API key with the prefix'),
    });
    const names = (await mcp.listTools()).tools.map((tool) => tool.name);
    expect(names.filter((name) => /create_api_key|register_webhook|rotate/.test(name))).toEqual([]);
  });

  it('publishes a refund policy from the current one, showing only what changes', async () => {
    const { client, writes } = fakeCore();
    const mcp = await connect(client);
    expect(
      await prepared(mcp, writes, 'set_refund_policy', {
        allowExpired: true,
        refundWindowDays: 30,
        reason: 'Tet season',
      }),
    ).toMatchObject({
      method: 'PUT',
      path: `${ORG}/refund-policy`,
      body: {
        allowUnused: true,
        allowExpired: true,
        allowRedeemed: false,
        restockUnused: true,
        refundWindowDays: 30,
        reason: 'Tet season',
      },
      summary:
        'Publish refund policy version 4: refund expired vouchers: off → on; refund window (days after claim): none → 30. ' +
        'Reason: "Tet season".',
    });
    expect(await prepared(mcp, writes, 'set_refund_policy', { allowUnused: true, reason: 'x' })).toMatchObject({
      error: expect.stringContaining('already the current refund policy'),
    });
  });

  it("changes the organization's settings and display", async () => {
    const { client, writes } = fakeCore();
    const mcp = await connect(client);
    expect(await prepared(mcp, writes, 'set_voucher_approval_required', { required: true })).toMatchObject({
      method: 'PATCH',
      path: `${ORG}/settings`,
      body: { voucherApprovalRequired: true },
    });
    expect((await prepared(mcp, writes, 'set_voucher_approval_required', { required: false })).summary).toContain(
      'Stop requiring',
    );
    expect(
      await prepared(mcp, writes, 'update_organization_display', { name: 'A Coffee House', logoUrl: null }),
    ).toMatchObject({
      path: `${ORG}/profile`,
      body: { name: 'A Coffee House', logoUrl: null },
      summary: 'Change the organization: name: "A Coffee" → "A Coffee House"; logo: removed.',
    });
    expect(
      await prepared(mcp, writes, 'update_organization_display', { logoUrl: 'http://x.example/a.png' }),
    ).toHaveProperty('error');
  });

  it('enables, disables and replays webhooks without showing a URL query string', async () => {
    const { client, writes } = fakeCore();
    const mcp = await connect(client);
    const disabled = await prepared(mcp, writes, 'disable_webhook_endpoint', { endpointId: ENDPOINT });
    expect(disabled).toMatchObject({ path: `${ORG}/webhooks/endpoints/${ENDPOINT}/disable` });
    expect(disabled.summary).toContain('https://hooks.example/octap');
    expect(disabled.summary).not.toContain('secret');
    expect(await prepared(mcp, writes, 'enable_webhook_endpoint', { endpointId: ENDPOINT })).toMatchObject({
      path: `${ORG}/webhooks/endpoints/${ENDPOINT}/enable`,
    });
    expect(await prepared(mcp, writes, 'send_test_webhook', { endpointId: ENDPOINT })).toMatchObject({
      method: 'POST',
      path: `${ORG}/webhooks/endpoints/${ENDPOINT}/test`,
      summary:
        'Send a webhook.test event to https://hooks.example/octap. Check list_webhook_deliveries for the result.',
    });
    expect(await prepared(mcp, writes, 'replay_webhook_delivery', { deliveryId: DELIVERY })).toMatchObject({
      path: `${ORG}/webhooks/deliveries/${DELIVERY}/replay`,
      summary: expect.stringContaining('credits.earned event'),
    });
    expect(await prepared(mcp, writes, 'enable_webhook_endpoint', { endpointId: DELIVERY })).toMatchObject({
      error: expect.stringContaining('No webhook endpoint'),
    });
    expect(await prepared(mcp, writes, 'replay_webhook_delivery', { deliveryId: ENDPOINT })).toMatchObject({
      error: expect.stringContaining('No recent webhook delivery'),
    });
  });

  it('gives a Developer only what Core lets a Developer do, and the prompts that go with the tools', async () => {
    const mcp = await connect(fakeCore().client, 'BUSINESS_DEVELOPER');
    const names = (await mcp.listTools()).tools.map((tool) => tool.name);
    for (const tool of [
      'import_vouchers',
      'activate_voucher_batch',
      'archive_voucher_batch',
      'revoke_api_key',
      'replay_webhook_delivery',
    ])
      expect(names).toContain(tool);
    for (const tool of ['pause_voucher_batch', 'block_member', 'set_refund_policy', 'disable_webhook_endpoint'])
      expect(names).not.toContain(tool);
    const prompts = (await mcp.listPrompts()).prompts.map((prompt) => prompt.name);
    expect(prompts).toContain('draft_voucher');
    expect(prompts).not.toContain('decide_pending_vouchers');

    const owner = await connect(fakeCore().client);
    expect((await owner.listPrompts()).prompts.map((prompt) => prompt.name)).toContain('decide_pending_vouchers');
    const prompt = await owner.getPrompt({ name: 'draft_voucher', arguments: { description: '10% off drinks' } });
    expect(JSON.stringify(prompt.messages)).toContain('confirm_change only if I agree');
  });

  it('offers a tool only when the client has the read it describes the change with', async () => {
    const { client } = fakeCore({ getRefundPolicy: undefined, listApiKeys: undefined });
    const names = (await (await connect(client)).listTools()).tools.map((tool) => tool.name);
    expect(names).not.toContain('set_refund_policy');
    expect(names).not.toContain('rename_api_key');
    expect(names).toContain('set_voucher_approval_required');
  });
});
