import { McpServer, type ServerContext } from '@modelcontextprotocol/server';
import { OctaPointClient } from '@octap/sdk';
import { readFileSync } from 'node:fs';
import * as z from 'zod/v4';
import { resolveCoreConfig } from './config.js';
import {
  CONSOLE_READ,
  CONSOLE_TOOLS,
  registerConsoleTools,
  type ConsoleReads,
  type ConsoleToolName,
} from './console-tools.js';
import {
  INSIGHT_READ,
  INSIGHT_TOOLS,
  registerInsightTools,
  type InsightReads,
  type InsightToolName,
} from './insight-tools.js';
import { BALANCE, OWNERSHIP, TRANSACTION, balanceOf, ownershipOf, transactionOf } from './shapes.js';
import { MemberBindingError, registerRead, type Projection, type ToolExtra } from './tool-kit.js';
import { WRITE_TOOLS, canServeWrites, registerWriteTools, type WriteToolName } from './write-tools.js';

export type {
  ApiKeyView,
  ConnectionInfo,
  ConsoleReads,
  ConsoleToolName,
  InvitationView,
  MemberDetailView,
  MemberPageView,
  MemberProfileView,
  MemberSearch,
  OrganizationView,
  RefundPolicyVersionView,
  RefundPolicyView,
  StaffView,
  WebhookDeliveryView,
  WebhookEndpointView,
} from './console-tools.js';
export { isOctaApiError, result, safeError, REQUEST_TIMEOUT_MS } from './tool-kit.js';
export type { ChangeInput, ConsoleWrites, WriteToolName } from './write-tools.js';
export type { InsightReads, InsightToolName } from './insight-tools.js';
export { WRITE_TOOLS } from './write-tools.js';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

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

const CURSOR_SCHEMA = z.string().min(1).max(500).optional().describe('nextCursor of the previous page');

export type MemberToolName = 'get_member_balance' | 'list_member_transactions' | 'list_member_vouchers';
export type ToolName = MemberToolName | ConsoleToolName | InsightToolName | WriteToolName;
export const MEMBER_TOOLS: MemberToolName[] = [
  'get_member_balance',
  'list_member_transactions',
  'list_member_vouchers',
];
/** Every read tool. Write tools are offered only when asked for (`tools`), to a signed-in user. */
export const ALL_TOOLS: ToolName[] = [...MEMBER_TOOLS, ...CONSOLE_TOOLS, ...INSIGHT_TOOLS];

/** The prompts this server can offer. Each needs certain tools; see `registerPrompts`. */
export type PromptName =
  | 'summarize_member'
  | 'check_member_transactions'
  | 'review_api_keys'
  | 'find_customer'
  | 'review_pending_vouchers'
  | 'check_budget'
  | 'check_webhooks'
  | 'review_console_access'
  | 'draft_voucher'
  | 'decide_pending_vouchers'
  | 'program_summary'
  | 'debug_integration';

export type CoreClientLike = Pick<OctaPointClient, 'getBalance' | 'listTransactions' | 'listMemberVouchers'> &
  Partial<ConsoleReads> &
  Partial<InsightReads>;

/** The tools this server offers: the allowed ones the client can actually serve. */
export function offeredTools(client: CoreClientLike, allowed: readonly ToolName[] = ALL_TOOLS): Set<ToolName> {
  const writes = canServeWrites(client);
  return new Set(
    allowed.filter((tool) =>
      (WRITE_TOOLS as string[]).includes(tool)
        ? writes
        : tool in CONSOLE_READ
          ? typeof client[CONSOLE_READ[tool as ConsoleToolName]] === 'function'
          : tool in INSIGHT_READ
            ? typeof client[INSIGHT_READ[tool as InsightToolName]] === 'function'
            : true,
    ),
  );
}

export type ResolveMemberIdContext = Pick<ServerContext, 'http'>;
export type MemberIdResolver = (
  context: ResolveMemberIdContext,
) => string | null | undefined | Promise<string | null | undefined>;

export interface CreateServerOptions {
  client?: CoreClientLike;
  /** Tools to offer. Defaults to every read tool the client can serve; write tools only when listed. */
  tools?: readonly ToolName[];
  /** Prompts to offer, among those whose tools are offered. Defaults to all of those. */
  prompts?: readonly PromptName[];
  /** Shown to the model when it connects, e.g. which persona this session acts as. */
  instructions?: string;
  resolveMemberId?: MemberIdResolver;
  /**
   * Rewrites a tool's value before it is returned. The value may then have any shape, so tools
   * declare no output schema while a projection is set.
   */
  project?: Projection<ToolName>;
}

export function coreClient(): OctaPointClient {
  const { apiUrl, apiKey } = resolveCoreConfig();
  return new OctaPointClient({ baseUrl: apiUrl, credentials: { apiKey } });
}

export function createServer(options: CreateServerOptions = {}) {
  const server = new McpServer(
    { name: 'octap', version: packageJson.version },
    options.instructions ? { instructions: options.instructions } : undefined,
  );
  const core = options.client ?? coreClient();
  const allowedTools = offeredTools(core, options.tools);
  registerMemberTools(server, core, allowedTools, options.resolveMemberId, options.project);
  registerConsoleTools(server, core, allowedTools, options.project);
  // The API-key client has none of these reads; each tool checks its own before registering.
  registerInsightTools(server, core as Partial<InsightReads>, allowedTools, options.project);
  if (canServeWrites(core)) registerWriteTools(server, core, allowedTools);
  registerPrompts(server, allowedTools, options.prompts);
  return server;
}

/**
 * The member tools, served by both clients: an API key (stdio) and a signed-in user (`serve-http`).
 * With `resolveMemberId` (a customer-facing embed), the member comes from the request, not the model.
 */
function registerMemberTools(
  server: McpServer,
  core: CoreClientLike,
  allowed: Set<ToolName>,
  resolveMemberId: MemberIdResolver | undefined,
  project: Projection<ToolName> | undefined,
) {
  const memberInput = <Shape extends z.ZodRawShape>(shape: Shape) =>
    resolveMemberId ? z.object(shape).strict() : z.object({ memberId: MEMBER_ID, ...shape }).strict();
  const memberOf = async (args: { memberId?: string }, extra: ToolExtra) => {
    const parsed = MEMBER_ID.safeParse(resolveMemberId ? await resolveMemberId(extra) : args.memberId);
    if (!parsed.success) throw new MemberBindingError();
    return parsed.data;
  };
  const notFound = 'No member with this id in the configured organization.';

  if (allowed.has('get_member_balance')) {
    registerRead<ToolName, { memberId?: string }, z.infer<typeof BALANCE>>(
      server,
      'get_member_balance',
      {
        description:
          'Read confirmed and pending credit balances for a member in the configured organization. ' +
          'Returns confirmedBalance (spendable), pendingEarn (in-flight earns), pendingRedemption (holds), ' +
          'lifetimeEarned, lifetimeRedeemed, and stale indicator.',
        input: memberInput({}),
        output: BALANCE,
        notFound,
        run: async (args, signal, extra) => {
          const memberId = await memberOf(args, extra);
          return balanceOf(await core.getBalance(memberId, { signal }), memberId);
        },
      },
      project,
    );
  }

  if (allowed.has('list_member_transactions')) {
    registerRead<
      ToolName,
      { memberId?: string; limit?: number; cursor?: string },
      { transactions: z.infer<typeof TRANSACTION>[]; nextCursor: string | null }
    >(
      server,
      'list_member_transactions',
      {
        description:
          "List a member's credit transactions, newest first, a page at a time: pass nextCursor back as " +
          'cursor for the next page. pointsAmount is null for pending transactions until settled.',
        input: memberInput({ limit: LIMIT_SCHEMA, cursor: CURSOR_SCHEMA }),
        output: z.object({ transactions: z.array(TRANSACTION), nextCursor: z.string().nullable() }),
        notFound,
        run: async (args, signal, extra) => {
          const memberId = await memberOf(args, extra);
          const page = await core.listTransactions(memberId, {
            limit: args.limit ?? DEFAULT_LIMIT,
            ...(args.cursor ? { cursor: args.cursor } : {}),
            signal,
          });
          return { transactions: page.items.map(transactionOf), nextCursor: page.nextCursor ?? null };
        },
      },
      project,
    );
  }

  if (allowed.has('list_member_vouchers')) {
    registerRead<ToolName, { memberId?: string; limit?: number }, { vouchers: z.infer<typeof OWNERSHIP>[] }>(
      server,
      'list_member_vouchers',
      {
        description:
          'List recent voucher ownerships for a member in the configured organization. ' +
          'Voucher serial codes are intentionally omitted for security.',
        input: memberInput({ limit: LIMIT_SCHEMA }),
        output: z.object({ vouchers: z.array(OWNERSHIP) }),
        notFound,
        run: async (args, signal, extra) => {
          const memberId = await memberOf(args, extra);
          // Core's route has no limit yet, so the newest are kept here.
          const rows = await core.listMemberVouchers(memberId, { signal });
          return { vouchers: rows.slice(0, args.limit ?? DEFAULT_LIMIT).map(ownershipOf) };
        },
      },
      project,
    );
  }
}

const MEMBER_ID_ARGS = z.object({ memberId: MEMBER_ID });

function userMessage(text: string) {
  return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
}

/**
 * Persona prompts (OCT-294). They guide the answer; they are not access control. A prompt is
 * offered only when every tool it relies on is, and `allowedPrompts` (the persona's) allows it.
 */
function registerPrompts(server: McpServer, tools: Set<ToolName>, allowedPrompts?: readonly PromptName[]) {
  const offers = (prompt: PromptName, ...needed: ToolName[]) =>
    (!allowedPrompts || allowedPrompts.includes(prompt)) && needed.every((tool) => tools.has(tool));

  if (offers('summarize_member', 'get_member_balance', 'list_member_transactions', 'list_member_vouchers')) {
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

  if (offers('check_member_transactions', 'get_member_balance', 'list_member_transactions')) {
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

  if (offers('review_api_keys', 'list_api_keys')) {
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

  if (offers('find_customer', 'find_member', 'get_member')) {
    server.registerPrompt(
      'find_customer',
      {
        title: 'Find a customer',
        description: 'Look a customer up by name, email, phone or POS id, then summarize them.',
        argsSchema: z.object({ who: z.string().min(1).max(100).describe('A name, email, phone number or POS id') }),
      },
      ({ who }) =>
        userMessage(
          `Find the customer "${who}" with find_member (try it as a POS id too if nothing matches). If several ` +
            'match, list them and ask which one. Then use get_member with their transactions and vouchers to ' +
            'summarize their points, recent activity and vouchers held, in under 10 lines. Use only the OctaP tools.',
        ),
    );
  }

  if (offers('review_pending_vouchers', 'list_vouchers', 'get_voucher')) {
    server.registerPrompt(
      'review_pending_vouchers',
      {
        title: 'Review vouchers waiting for approval',
        description: 'What waits for an Owner, and anything to check before approving it.',
      },
      () =>
        userMessage(
          'List the vouchers waiting for approval (list_vouchers with status PENDING_APPROVAL). For each, read it ' +
            'with get_voucher and summarize what the customer gets, the points cost, supply and dates, and flag ' +
            'anything worth checking (very low points cost, no supply limit, expiring within a week). Use only ' +
            'the OctaP tools; you cannot approve anything from here.',
        ),
    );
  }

  if (offers('check_budget', 'get_budget')) {
    server.registerPrompt(
      'check_budget',
      {
        title: 'Check our points budget',
        description: 'How much points budget is left, and whether a top-up is needed soon.',
      },
      () =>
        userMessage(
          'Check our points issuance budget with get_budget: how much is left, the share used, any low-budget ' +
            'warning, and whether one shard is close to running out. Say plainly whether we should ask for a ' +
            'top-up. Use only the OctaP tools.',
        ),
    );
  }

  if (offers('check_webhooks', 'list_webhook_endpoints', 'list_webhook_deliveries')) {
    server.registerPrompt(
      'check_webhooks',
      {
        title: 'Why did my webhooks fail?',
        description: 'Failed or retrying webhook deliveries, grouped by endpoint, with the likely cause.',
      },
      () =>
        userMessage(
          'Check our webhooks: list the endpoints, then the deliveries that are DEAD_LETTER or still PENDING. ' +
            'Group them by endpoint and event type, and explain the likely cause from the last HTTP status and ' +
            'error (e.g. 401 means our receiver rejected the signature). Use only the OctaP tools.',
        ),
    );
  }

  if (offers('program_summary', 'get_program_analytics')) {
    server.registerPrompt(
      'program_summary',
      {
        title: 'How is our program doing?',
        description: 'Points, members and vouchers over a period, compared with the period before.',
        argsSchema: z.object({
          days: z
            .string()
            .regex(/^\d{1,3}$/)
            .optional()
            .describe('Days to look back, default 7'),
        }),
      },
      ({ days }) =>
        userMessage(
          `Summarize how our loyalty program did over the last ${days ?? '7'} days with get_program_analytics, and ` +
            'compare it with the same length of time before it: points earned and redeemed, active versus enrolled ' +
            'members, and vouchers claimed, redeemed and expired unused. Point out anything that changed a lot. ' +
            'Use only the OctaP tools, and keep it under 12 lines.',
        ),
    );
  }

  if (offers('debug_integration', 'get_api_errors', 'search_request_logs', 'get_request_log')) {
    server.registerPrompt(
      'debug_integration',
      {
        title: 'Why are my API calls failing?',
        description: 'Failing calls grouped by cause, with the likely fix for each.',
      },
      () =>
        userMessage(
          'Find out why our API calls are failing. Start with get_api_errors for the last 24 hours, then for the ' +
            'most frequent groups read one call with get_request_log. For each, say which route and API key, the ' +
            'error, the likely cause (for example a 401 is a wrong or revoked key, a 409 a reused idempotency key) ' +
            'and what to change in our integration. Use only the OctaP tools.',
        ),
    );
  }

  // Write prompts (OCT-314): offered only to a connection allowed to make changes, as their tools are.
  if (offers('draft_voucher', 'create_voucher', 'confirm_change')) {
    server.registerPrompt(
      'draft_voucher',
      {
        title: 'Create a voucher from a description',
        description: 'Turn a sentence such as "10% off drinks for 200 points until Tet" into a draft voucher.',
        argsSchema: z.object({ description: z.string().min(1).max(1000).describe('What the voucher should be') }),
      },
      ({ description }) =>
        userMessage(
          `Create a draft voucher from this description: "${description}". Work out the code, title, points ` +
            'cost, discount and dates; ask me for anything you cannot tell rather than guessing a price or a ' +
            'date. Then call create_voucher, show me its summary word for word, and call confirm_change only if ' +
            'I agree. It stays a draft: do not activate it unless I ask.',
        ),
    );
  }

  if (
    offers(
      'decide_pending_vouchers',
      'list_vouchers',
      'get_voucher',
      'approve_voucher',
      'reject_voucher',
      'confirm_change',
    )
  ) {
    server.registerPrompt(
      'decide_pending_vouchers',
      {
        title: 'Approve what waits for me',
        description: 'Go through the vouchers waiting for approval, and approve or reject each one with me.',
      },
      () =>
        userMessage(
          'List the vouchers waiting for my approval (list_vouchers with status PENDING_APPROVAL). For each one, ' +
            'read it with get_voucher, summarize what the customer gets, the points cost, supply and dates, and ' +
            'flag anything worth checking. Ask me whether to approve or reject it (and why, if rejecting), then ' +
            'prepare that with approve_voucher or reject_voucher, show me the summary and call confirm_change ' +
            'only once I agree. One voucher at a time.',
        ),
    );
  }

  if (offers('review_console_access', 'list_staff', 'list_invitations')) {
    server.registerPrompt(
      'review_console_access',
      {
        title: 'Who has access to our console?',
        description: 'Owners and Business Developers, suspended staff, and pending invitations.',
      },
      () =>
        userMessage(
          'Who can sign in to our console? List the Owners and Business Developers and their status, then the ' +
            'pending or expired invitations. Point out anything unusual, like a pending invitation that is ' +
            'about to expire. Use only the OctaP tools.',
        ),
    );
  }
}
