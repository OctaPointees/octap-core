import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, type AuthInfo } from '@modelcontextprotocol/server';
import type { CoreClientLike } from '../src/server.js';
import { createCustomerMcpServer } from '../examples/customer-embed.js';

describe('README customer embedding example', () => {
  it('keeps the README example identical to the executable TypeScript example', async () => {
    const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
    const example = await readFile(new URL('../examples/customer-embed.ts', import.meta.url), 'utf8');
    const programmaticSection = readme.split('## Programmatic Usage\n')[1];
    const readmeExample = programmaticSection?.match(/```typescript\n([\s\S]*?)\n```/)?.[1];

    expect(readmeExample).toBe(example.trim());
  });

  it('binds validated HTTP authInfo to its member through the real client protocol', async () => {
    const memberId = '77777777-7777-4777-8777-777777777777';
    const authenticatedSessions = {
      getMemberId: vi.fn(async (authInfo: AuthInfo) => authInfo.extra?.memberId as string | undefined),
    };
    const coreClient: CoreClientLike = {
      getBalance: vi.fn().mockResolvedValue({
        organizationEndUserId: memberId,
        confirmedBalance: 88,
        pendingEarn: 0,
        pendingRedemption: 0,
        lifetimeEarned: 88,
        lifetimeRedeemed: 0,
        asOfCheckpoint: '10',
        observedAt: '2026-11-12T12:00:00Z',
        stale: false,
      }),
      listTransactions: vi.fn().mockResolvedValue([]),
      listMemberVouchers: vi.fn(),
    };
    const server = createCustomerMcpServer(authenticatedSessions, coreClient);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const authInfo: AuthInfo = {
      token: 'validated-test-token',
      clientId: 'customer-chat-host',
      scopes: ['member:read'],
      extra: { memberId },
    };
    const send = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message, options) => send(message, { ...options, authInfo });
    const client = new Client({ name: 'customer-embed-example-test', version: '1.0.0' }, { capabilities: {} });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual(['get_member_balance', 'list_member_transactions']);

      const response = await client.callTool({ name: 'get_member_balance', arguments: {} });
      expect(response.isError).toBeFalsy();
      expect(authenticatedSessions.getMemberId).toHaveBeenCalledWith(authInfo);
      expect(coreClient.getBalance).toHaveBeenCalledWith(memberId, expect.any(Object));
    } finally {
      await client.close();
      await server.close();
    }
  });

  it.each([
    ['missing auth mapping', undefined],
    ['invalid member UUID', 'not-a-uuid'],
  ])('fails closed for %s without calling Core', async (_caseName, resolvedMemberId) => {
    const coreClient: CoreClientLike = {
      getBalance: vi.fn(),
      listTransactions: vi.fn(),
      listMemberVouchers: vi.fn(),
    };
    const authenticatedSessions = { getMemberId: vi.fn(() => resolvedMemberId) };
    const server = createCustomerMcpServer(authenticatedSessions, coreClient);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const send = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message, options) =>
      send(message, {
        ...options,
        authInfo: {
          token: 'validated-test-token',
          clientId: 'customer-chat-host',
          scopes: ['member:read'],
          extra: { memberId: resolvedMemberId },
        },
      });
    const client = new Client({ name: 'customer-embed-fail-closed-test', version: '1.0.0' }, { capabilities: {} });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const response = await client.callTool({ name: 'get_member_balance', arguments: {} });
      expect(response.isError).toBe(true);
      const content = response.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toBe('No authenticated member is bound to this request.');
      expect(coreClient.getBalance).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('fails closed when the request has no validated authInfo', async () => {
    const coreClient: CoreClientLike = {
      getBalance: vi.fn(),
      listTransactions: vi.fn(),
      listMemberVouchers: vi.fn(),
    };
    const authenticatedSessions = { getMemberId: vi.fn(() => '77777777-7777-4777-8777-777777777777') };
    const server = createCustomerMcpServer(authenticatedSessions, coreClient);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'customer-embed-no-auth-test', version: '1.0.0' }, { capabilities: {} });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const response = await client.callTool({ name: 'get_member_balance', arguments: {} });
      expect(response.isError).toBe(true);
      expect(authenticatedSessions.getMemberId).not.toHaveBeenCalled();
      expect(coreClient.getBalance).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
