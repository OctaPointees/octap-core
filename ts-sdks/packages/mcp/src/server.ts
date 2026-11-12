import { McpServer, type ServerContext } from '@modelcontextprotocol/server';
import { OctaPointClient, OctaApiError } from '@octap/sdk';
import { readFileSync } from 'node:fs';
import * as z from 'zod/v4';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export const REQUEST_TIMEOUT_MS = 12_000;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;
export const MEMBER_ID = z.string().uuid().describe('Octap organization member UUID');

export const LIMIT_SCHEMA = z
  .number()
  .int()
  .min(1)
  .max(MAX_LIMIT)
  .default(DEFAULT_LIMIT)
  .describe('Maximum number of items to return (1-50, default 20)');

export type ToolName = 'get_member_balance' | 'list_member_transactions' | 'list_member_vouchers';
export const ALL_TOOLS: ToolName[] = ['get_member_balance', 'list_member_transactions', 'list_member_vouchers'];

export type CoreClientLike = Pick<OctaPointClient, 'getBalance' | 'listTransactions' | 'listMemberVouchers'>;

export type ResolveMemberIdContext = Pick<ServerContext, 'http'>;
export type MemberIdResolver = (
  context: ResolveMemberIdContext,
) => string | null | undefined | Promise<string | null | undefined>;

export interface CreateServerOptions {
  client?: CoreClientLike;
  tools?: ToolName[];
  resolveMemberId?: MemberIdResolver;
  project?: (tool: ToolName, value: unknown) => unknown;
}

function memberBindingError() {
  console.error(JSON.stringify({ event: 'mcp_member_binding_failed' }));
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: 'No authenticated member is bound to this request.' }],
  };
}

export function isOctaApiError(err: unknown): err is OctaApiError {
  if (err instanceof OctaApiError) return true;
  if (err !== null && typeof err === 'object') {
    const candidate = err as Record<string, unknown>;
    return typeof candidate.statusCode === 'number' && candidate.name === 'OctaApiError';
  }
  return false;
}

export function coreClient(): OctaPointClient {
  const apiKey = process.env.OCTAP_API_KEY?.trim();
  if (!apiKey) throw new Error('OCTAP_API_KEY is required');

  const rawUrl = process.env.OCTAP_API_URL?.trim();
  if (!rawUrl) throw new Error('OCTAP_API_URL is required');

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('OCTAP_API_URL must be an absolute HTTP(S) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('OCTAP_API_URL must use HTTP or HTTPS');
  }

  return new OctaPointClient({ baseUrl: parsed.toString(), credentials: { apiKey } });
}

export function safeError(tool: string, error: unknown) {
  if (isOctaApiError(error)) {
    console.error(JSON.stringify({ event: 'core_api_error', tool, status: error.statusCode }));
    const message =
      error.statusCode === 401 || error.statusCode === 403
        ? 'Core denied this read. Check that the configured credential is valid and has the read scope.'
        : error.statusCode === 404
          ? 'No matching member or resource was found in the configured organization.'
          : error.statusCode === 429
            ? 'Rate limited; do not retry this call in this turn.'
            : error.statusCode >= 500
              ? 'Core is temporarily unavailable; do not retry this call in this turn.'
              : 'Core rejected this request. Check the member ID and tool inputs.';
    return { isError: true as const, content: [{ type: 'text' as const, text: message }] };
  }

  // Do not serialize arbitrary errors: SDK/network errors may contain sensitive request details.
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

type ToolExtra = ServerContext & { signal?: AbortSignal };

function combineSignal(extra?: Pick<ToolExtra, 'signal' | 'mcpReq'>): AbortSignal {
  const hostSignal = extra?.signal ?? extra?.mcpReq?.signal;
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return hostSignal ? AbortSignal.any([hostSignal, timeoutSignal]) : timeoutSignal;
}

export function createServer(options: CreateServerOptions = {}) {
  const server = new McpServer({ name: 'octap', version: packageJson.version });
  const core = options.client ?? coreClient();
  const allowedTools = options.tools ? new Set(options.tools) : new Set(ALL_TOOLS);
  const resolveMemberId = options.resolveMemberId;
  const project = options.project ?? ((_tool, val) => val);

  if (allowedTools.has('get_member_balance')) {
    const balanceSchema = resolveMemberId ? z.object({}).strict() : z.object({ memberId: MEMBER_ID }).strict();

    server.registerTool(
      'get_member_balance',
      {
        description:
          'Read confirmed and pending credit balances for a member in the configured organization. ' +
          'Returns confirmedBalance (spendable), pendingEarn (in-flight earns), pendingRedemption (holds), ' +
          'lifetimeEarned, lifetimeRedeemed, and stale indicator.',
        inputSchema: balanceSchema,
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async (args: { memberId?: string }, extra: ToolExtra) => {
        try {
          const memberId = resolveMemberId ? await resolveMemberId(extra) : args.memberId;
          const parsedMemberId = MEMBER_ID.safeParse(memberId);
          if (!parsedMemberId.success) return memberBindingError();
          const balance = await core.getBalance(parsedMemberId.data, { signal: combineSignal(extra) });
          const rawPayload = {
            memberId: balance.organizationEndUserId,
            confirmedBalance: balance.confirmedBalance,
            pendingEarn: balance.pendingEarn,
            pendingRedemption: balance.pendingRedemption,
            lifetimeEarned: balance.lifetimeEarned,
            lifetimeRedeemed: balance.lifetimeRedeemed,
            asOfCheckpoint: balance.asOfCheckpoint,
            observedAt: balance.observedAt,
            stale: balance.stale,
          };
          return result('get_member_balance', project('get_member_balance', rawPayload));
        } catch (error) {
          return safeError('get_member_balance', error);
        }
      },
    );
  }

  if (allowedTools.has('list_member_transactions')) {
    const txSchema = resolveMemberId
      ? z.object({ limit: LIMIT_SCHEMA }).strict()
      : z.object({ memberId: MEMBER_ID, limit: LIMIT_SCHEMA }).strict();

    server.registerTool(
      'list_member_transactions',
      {
        description:
          'List a bounded number of recent credit transactions for a member in newest-first order. ' +
          'pointsAmount is null for pending transactions until settled.',
        inputSchema: txSchema,
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async (args: { memberId?: string; limit?: number }, extra: ToolExtra) => {
        try {
          const memberId = resolveMemberId ? await resolveMemberId(extra) : args.memberId;
          const parsedMemberId = MEMBER_ID.safeParse(memberId);
          if (!parsedMemberId.success) return memberBindingError();
          const limit = args.limit ?? DEFAULT_LIMIT;
          const rows = await core.listTransactions(parsedMemberId.data, {
            limit,
            signal: combineSignal(extra),
          });
          const rawPayload = rows.map((tx) => ({
            transactionId: tx.id,
            type: tx.transactionType,
            status: tx.status,
            pointsAmount: tx.pointsAmount,
            estimatedPoints: tx.estimatedPoints,
            purchaseAmount: tx.purchaseAmount,
            blockchainDigest: tx.blockchainDigest,
            createdAt: tx.createdAt,
            updatedAt: tx.updatedAt,
          }));
          return result('list_member_transactions', project('list_member_transactions', rawPayload));
        } catch (error) {
          return safeError('list_member_transactions', error);
        }
      },
    );
  }

  if (allowedTools.has('list_member_vouchers')) {
    const voucherSchema = resolveMemberId
      ? z.object({ limit: LIMIT_SCHEMA }).strict()
      : z.object({ memberId: MEMBER_ID, limit: LIMIT_SCHEMA }).strict();

    server.registerTool(
      'list_member_vouchers',
      {
        description:
          'List recent voucher ownerships for a member in the configured organization. ' +
          'Voucher serial codes are intentionally omitted for security.',
        inputSchema: voucherSchema,
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async (args: { memberId?: string; limit?: number }, extra: ToolExtra) => {
        try {
          const memberId = resolveMemberId ? await resolveMemberId(extra) : args.memberId;
          const parsedMemberId = MEMBER_ID.safeParse(memberId);
          if (!parsedMemberId.success) return memberBindingError();
          const limit = args.limit ?? DEFAULT_LIMIT;
          // Note: Core endpoint does not support limit parameter currently; fetched and sliced client-side.
          const rows = await core.listMemberVouchers(parsedMemberId.data, { signal: combineSignal(extra) });
          const rawPayload = rows.slice(0, limit).map((voucher) => ({
            ownershipId: voucher.id,
            voucherId: voucher.voucherId,
            status: voucher.status,
            claimedAt: voucher.claimedAt,
            redeemedAt: voucher.redeemedAt,
            expiresAt: voucher.expiresAt,
            title: voucher.voucher?.title,
          }));
          return result('list_member_vouchers', project('list_member_vouchers', rawPayload));
        } catch (error) {
          return safeError('list_member_vouchers', error);
        }
      },
    );
  }

  return server;
}
