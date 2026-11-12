import { createServer, type CoreClientLike } from '@octap/mcp';
import type { ServerContext, Transport } from '@modelcontextprotocol/server';

type AuthenticatedSessions = {
  getMemberId(
    authInfo: NonNullable<ServerContext['http']>['authInfo'],
  ): string | undefined | Promise<string | undefined>;
};

export function createCustomerMcpServer(authenticatedSessions: AuthenticatedSessions, client?: CoreClientLike) {
  return createServer({
    ...(client ? { client } : {}),
    tools: ['get_member_balance', 'list_member_transactions'],
    resolveMemberId: ({ http }) => (http?.authInfo ? authenticatedSessions.getMemberId(http.authInfo) : undefined),
    project: (toolName, data) => data,
  });
}

export async function connectCustomerMcp(authenticatedSessions: AuthenticatedSessions, transport: Transport) {
  const server = createCustomerMcpServer(authenticatedSessions);
  await server.connect(transport);
  return server;
}
