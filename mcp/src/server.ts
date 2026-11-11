import { McpServer } from '@modelcontextprotocol/server';
import { OctaPointClient, OctaApiError } from '@octap/sdk';
import * as z from 'zod/v4';

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;
export const MEMBER_ID = z.string().uuid().describe('Octap organization member UUID');

export type CoreClientLike = Pick<OctaPointClient, 'getBalance' | 'listTransactions' | 'listMemberVouchers'>;

export function coreClient(): OctaPointClient {
  const apiKey = process.env.OCTAP_CORE_API_KEY?.trim();
  if (!apiKey) throw new Error('OCTAP_CORE_API_KEY is required');

  const baseUrl = (process.env.OCTAP_CORE_API_URL ?? 'http://127.0.0.1:3000').trim();
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('OCTAP_CORE_API_URL must be an absolute HTTP(S) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('OCTAP_CORE_API_URL must use HTTP or HTTPS');
  }

  return new OctaPointClient({ baseUrl: parsed.toString(), credentials: { apiKey } });
}

export function safeError(tool: string, error: unknown) {
  if (error instanceof OctaApiError) {
    console.error(JSON.stringify({ event: 'core_api_error', tool, status: error.statusCode }));
    const message =
      error.statusCode === 401 || error.statusCode === 403
        ? 'Core denied this read. Check that the configured credential is valid and has the read scope.'
        : error.statusCode === 404
          ? 'No matching member or resource was found in the configured organization.'
          : error.statusCode === 429
            ? 'Core rate limited this request. Try again shortly.'
            : error.statusCode >= 500
              ? 'Core is temporarily unavailable. Try again shortly.'
              : 'Core rejected this request. Check the member ID and tool inputs.';
    return { isError: true as const, content: [{ type: 'text' as const, text: message }] };
  }

  // Do not serialize arbitrary errors: SDK/network errors may contain request details.
  console.error(JSON.stringify({ event: 'core_request_failed', tool }));
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: 'Core could not complete this read. Check the local server logs.' }],
  };
}

export function result(tool: string, value: unknown) {
  console.error(JSON.stringify({ event: 'mcp_tool_result', tool, outcome: 'success' }));
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

export function createServer(optionsOrClient?: CoreClientLike | { client?: CoreClientLike }) {
  const server = new McpServer({ name: 'octap-core-readonly', version: '0.1.0' });
  const core =
    optionsOrClient && 'getBalance' in optionsOrClient
      ? optionsOrClient
      : optionsOrClient && 'client' in optionsOrClient && optionsOrClient.client
        ? optionsOrClient.client
        : coreClient();

  server.registerTool(
    'get_member_balance',
    {
      description:
        'Read the current confirmed and pending credit balance for a member in the organization configured for this server.',
      inputSchema: z.object({ memberId: MEMBER_ID }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ memberId }) => {
      try {
        const balance = await core.getBalance(memberId, { signal: AbortSignal.timeout(12_000) });
        return result('get_member_balance', {
          memberId: balance.organizationEndUserId,
          confirmedBalance: balance.confirmedBalance,
          pendingEarn: balance.pendingEarn,
          pendingRedemption: balance.pendingRedemption,
          lifetimeEarned: balance.lifetimeEarned,
          lifetimeRedeemed: balance.lifetimeRedeemed,
          asOfCheckpoint: balance.asOfCheckpoint,
          observedAt: balance.observedAt,
          stale: balance.stale,
        });
      } catch (error) {
        return safeError('get_member_balance', error);
      }
    },
  );

  server.registerTool(
    'list_member_transactions',
    {
      description:
        'List a bounded number of recent credit transactions for a member in the configured organization. Results are newest first.',
      inputSchema: z
        .object({ memberId: MEMBER_ID, limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT) })
        .strict(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ memberId, limit }) => {
      try {
        const rows = await core.listTransactions(memberId, {
          limit,
          signal: AbortSignal.timeout(12_000),
        });
        return result(
          'list_member_transactions',
          rows.map((tx) => ({
            transactionId: tx.id,
            type: tx.transactionType,
            status: tx.status,
            pointsAmount: tx.pointsAmount,
            estimatedPoints: tx.estimatedPoints,
            purchaseAmount: tx.purchaseAmount,
            blockchainDigest: tx.blockchainDigest,
            createdAt: tx.createdAt,
            updatedAt: tx.updatedAt,
          })),
        );
      } catch (error) {
        return safeError('list_member_transactions', error);
      }
    },
  );

  server.registerTool(
    'list_member_vouchers',
    {
      description:
        'List up to 50 recent voucher ownerships for a member in the configured organization. Voucher serial codes are intentionally omitted.',
      inputSchema: z
        .object({ memberId: MEMBER_ID, limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT) })
        .strict(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ memberId, limit }) => {
      try {
        const rows = await core.listMemberVouchers(memberId, { signal: AbortSignal.timeout(12_000) });
        return result(
          'list_member_vouchers',
          rows.slice(0, limit).map((voucher) => ({
            ownershipId: voucher.id,
            voucherId: voucher.voucherId,
            status: voucher.status,
            claimedAt: voucher.claimedAt,
            redeemedAt: voucher.redeemedAt,
            expiresAt: voucher.expiresAt,
            title: voucher.voucher?.title,
          })),
        );
      } catch (error) {
        return safeError('list_member_vouchers', error);
      }
    },
  );

  return server;
}
