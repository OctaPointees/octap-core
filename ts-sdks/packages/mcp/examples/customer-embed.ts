import { coreClient, createServer, type CoreClientLike } from '@octap/mcp';
import type { Transport } from '@modelcontextprotocol/server';

type AuthenticatedSessions = {
  getMemberId(sessionId: string): string | undefined | Promise<string | undefined>;
};

export function createCustomerMcpServer(
  authenticatedSessions: AuthenticatedSessions,
  client: CoreClientLike = coreClient(),
) {
  return createServer({
    client,
    tools: ['get_member_balance', 'list_member_transactions'],
    resolveMemberId: ({ sessionId }) => (sessionId ? authenticatedSessions.getMemberId(sessionId) : undefined),
    project: (toolName, data) => data,
  });
}

export async function connectCustomerMcp(authenticatedSessions: AuthenticatedSessions, transport: Transport) {
  const server = createCustomerMcpServer(authenticatedSessions);
  await server.connect(transport);
  return server;
}
