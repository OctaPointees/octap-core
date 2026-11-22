import { McpServer, type ServerContext } from '@modelcontextprotocol/server';
import { OctaPointClient, OctaApiError } from '@octap/sdk';
import { readFileSync } from 'node:fs';
import * as z from 'zod/v4';
import { resolveCoreConfig } from './config.js';

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

export type MemberToolName = 'get_member_balance' | 'list_member_transactions' | 'list_member_vouchers';
/** Tools that read the signed-in user's console routes; only the console client (`serve-http`) has them. */
export type ConsoleToolName = 'get_connection' | 'get_refund_policy' | 'list_api_keys';
export type ToolName = MemberToolName | ConsoleToolName;
export const MEMBER_TOOLS: MemberToolName[] = [
  'get_member_balance',
  'list_member_transactions',
  'list_member_vouchers',
];
export const ALL_TOOLS: ToolName[] = [...MEMBER_TOOLS, 'get_connection', 'get_refund_policy', 'list_api_keys'];

interface RequestOptions {
  signal?: AbortSignal;
}

/** Who this MCP session acts as, from Core's `GET /v1/console/me` for the session's token. */
export interface ConnectionInfo {
  organization: { id: string; name: string; slug: string };
  persona: string;
  signedInAs: string;
  expiresAt: string;
}

/** The organization's current voucher refund policy (`VoucherRefundPolicyDto` in `@octap/contracts`). */
export interface RefundPolicyView {
  version: number;
  allowUnused: boolean;
  allowExpired: boolean;
  allowRedeemed: boolean;
  restockUnused: boolean;
  refundWindowDays: number | null;
  reason?: string;
  createdAt?: string | null;
}

/** An API key as the console lists it (`ConsoleCredential`). Core never returns the key or its hash. */
export interface ApiKeyView {
  name: string;
  keyPrefix: string;
  scopes: string[];
  status: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** Reads only the console client offers (OCT-294). A tool whose read is missing is not offered. */
export interface ConsoleReads {
  getConnection(options?: RequestOptions): Promise<ConnectionInfo>;
  getRefundPolicy(options?: RequestOptions): Promise<RefundPolicyView>;
  listApiKeys(options?: RequestOptions): Promise<ApiKeyView[]>;
}

export type CoreClientLike = Pick<OctaPointClient, 'getBalance' | 'listTransactions' | 'listMemberVouchers'> &
  Partial<ConsoleReads>;

const CONSOLE_READ: Record<ConsoleToolName, keyof ConsoleReads> = {
  get_connection: 'getConnection',
  get_refund_policy: 'getRefundPolicy',
  list_api_keys: 'listApiKeys',
};

/** The tools this server offers: the allowed ones the client can actually serve. */
export function offeredTools(client: CoreClientLike, allowed: readonly ToolName[] = ALL_TOOLS): Set<ToolName> {
  return new Set(
    allowed.filter((tool) =>
      tool in CONSOLE_READ ? typeof client[CONSOLE_READ[tool as ConsoleToolName]] === 'function' : true,
    ),
  );
}

export type ResolveMemberIdContext = Pick<ServerContext, 'http'>;
export type MemberIdResolver = (
  context: ResolveMemberIdContext,
) => string | null | undefined | Promise<string | null | undefined>;

export interface CreateServerOptions {
  client?: CoreClientLike;
  /** Tools to offer. Defaults to every tool the client can serve. */
  tools?: readonly ToolName[];
  /** Shown to the model when it connects, e.g. which persona this session acts as. */
  instructions?: string;
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
  const { apiUrl, apiKey } = resolveCoreConfig();
  return new OctaPointClient({ baseUrl: apiUrl, credentials: { apiKey } });
}

export function safeError(tool: string, error: unknown) {
  if (isOctaApiError(error)) {
    console.error(JSON.stringify({ event: 'core_api_error', tool, status: error.statusCode }));
    const message =
      error.statusCode === 401 || error.statusCode === 403
        ? 'Core denied this read. The signed-in role or the configured credential is not allowed to read this.'
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
  const server = new McpServer(
    { name: 'octap', version: packageJson.version },
    options.instructions ? { instructions: options.instructions } : undefined,
  );
  const core = options.client ?? coreClient();
  const allowedTools = offeredTools(core, options.tools);
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
          const { items: rows } = await core.listTransactions(parsedMemberId.data, {
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

  registerConsoleTools(server, core, allowedTools, project);
  registerPrompts(server, allowedTools);

  return server;
}

const EMPTY_INPUT = z.object({}).strict();

/** The console-only reads (OCT-294). `allowedTools` already holds only those the client can serve. */
function registerConsoleTools(
  server: McpServer,
  core: CoreClientLike,
  allowedTools: Set<ToolName>,
  project: (tool: ToolName, value: unknown) => unknown,
) {
  const read =
    <T>(tool: ConsoleToolName, run: (signal: AbortSignal) => Promise<T>, shape: (value: T) => unknown) =>
    async (_args: Record<string, never>, extra: ToolExtra) => {
      try {
        return result(tool, project(tool, shape(await run(combineSignal(extra)))));
      } catch (error) {
        return safeError(tool, error);
      }
    };
  const annotations = { readOnlyHint: true, openWorldHint: true };

  if (allowedTools.has('get_connection') && core.getConnection) {
    const getConnection = core.getConnection.bind(core);
    server.registerTool(
      'get_connection',
      {
        description:
          'Show which OctaP organization this session is connected to, the persona (Business Owner or ' +
          'Business Developer), the signed-in user, and when the sign-in expires. Every other tool reads ' +
          'this organization only.',
        inputSchema: EMPTY_INPUT,
        annotations,
      },
      read(
        'get_connection',
        (signal) => getConnection({ signal }),
        (connection) => connection,
      ),
    );
  }

  if (allowedTools.has('get_refund_policy') && core.getRefundPolicy) {
    const getRefundPolicy = core.getRefundPolicy.bind(core);
    server.registerTool(
      'get_refund_policy',
      {
        description:
          "Read the organization's current voucher refund policy: which vouchers can be refunded (unused, " +
          'expired, redeemed), whether a refunded unused voucher goes back to stock, and the refund window in days.',
        inputSchema: EMPTY_INPUT,
        annotations,
      },
      read(
        'get_refund_policy',
        (signal) => getRefundPolicy({ signal }),
        (policy) => ({
          version: policy.version,
          allowUnused: policy.allowUnused,
          allowExpired: policy.allowExpired,
          allowRedeemed: policy.allowRedeemed,
          restockUnused: policy.restockUnused,
          refundWindowDays: policy.refundWindowDays,
          reason: policy.reason,
          publishedAt: policy.createdAt,
        }),
      ),
    );
  }

  if (allowedTools.has('list_api_keys') && core.listApiKeys) {
    const listApiKeys = core.listApiKeys.bind(core);
    server.registerTool(
      'list_api_keys',
      {
        description:
          "List the organization's API keys: name, key prefix, scopes (read, or read and write), status, " +
          'when each was created and last used. The keys themselves are never returned.',
        inputSchema: EMPTY_INPUT,
        annotations,
      },
      read(
        'list_api_keys',
        (signal) => listApiKeys({ signal }),
        // Whitelist the fields, so nothing Core adds later passes through unreviewed.
        (keys) =>
          keys.map((key) => ({
            name: key.name,
            keyPrefix: key.keyPrefix,
            scopes: key.scopes,
            status: key.status,
            createdAt: key.createdAt,
            lastUsedAt: key.lastUsedAt,
          })),
      ),
    );
  }
}

const MEMBER_ID_ARGS = z.object({ memberId: MEMBER_ID });

function userMessage(text: string) {
  return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
}

/**
 * Persona prompts (OCT-294). They guide the answer; they are not access control. A prompt is offered
 * only when every tool it relies on is, so each persona gets the prompts that fit its tool set.
 */
function registerPrompts(server: McpServer, tools: Set<ToolName>) {
  const offers = (...needed: ToolName[]) => needed.every((tool) => tools.has(tool));

  if (offers('get_member_balance', 'list_member_transactions', 'list_member_vouchers')) {
    server.registerPrompt(
      'summarize_member',
      {
        title: "Summarize a member's activity",
        description: 'Balance, recent points activity and vouchers held, as a short summary.',
        argsSchema: MEMBER_ID_ARGS,
      },
      ({ memberId }) =>
        userMessage(
          `Summarize member ${memberId} for me: their confirmed and pending points, what they earned and ` +
            'redeemed recently, and which vouchers they hold and whether they used them. Use only the OctaP ' +
            "tools, keep it under 10 lines, and say plainly if something couldn't be read.",
        ),
    );
  }

  if (offers('get_member_balance', 'list_member_transactions')) {
    server.registerPrompt(
      'check_member_transactions',
      {
        title: "Check a member's transactions",
        description: 'Find pending or failed points transactions for one member, to debug an integration.',
        argsSchema: MEMBER_ID_ARGS,
      },
      ({ memberId }) =>
        userMessage(
          `Check member ${memberId}'s recent points transactions. List any that are still PENDING or failed, ` +
            'with their type, amount and time, and say whether the balance is consistent with them. Use only ' +
            'the OctaP tools.',
        ),
    );
  }

  if (offers('list_api_keys')) {
    server.registerPrompt(
      'review_api_keys',
      {
        title: 'Review API keys',
        description: 'Spot API keys that were never used, are stale, or have write access.',
      },
      () =>
        userMessage(
          "Review my organization's API keys. Point out keys that were never used, keys not used in the last " +
            '30 days, and keys with write access, and suggest which ones to revoke. Use only the OctaP tools.',
        ),
    );
  }
}
