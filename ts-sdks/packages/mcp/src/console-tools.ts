import type { McpServer } from '@modelcontextprotocol/server';
import type {
  CreditBalanceSnapshot,
  IssuanceBudgetDto,
  LoyaltyTransactionPage,
  VoucherBatchDetailDto,
  VoucherBatchDto,
  VoucherDto,
  VoucherOwnershipDto,
} from '@octap/sdk';
import * as z from 'zod/v4';
import { BALANCE, OWNERSHIP, TRANSACTION, balanceOf, ownershipOf, transactionOf } from './shapes.js';
import { nullableNumber, nullableString, orNull, registerRead, type Projection } from './tool-kit.js';

interface RequestOptions {
  signal?: AbortSignal;
}

// -------------------------------------------------------------------------------------------------
// What Core's console routes answer (only the fields the tools read)
// -------------------------------------------------------------------------------------------------

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

/** `GET …/organizations/:id` (the console's organization detail). */
export interface OrganizationView {
  id: string;
  name: string;
  slug: string;
  legalName?: string | null;
  organizationType?: string | null;
  status?: string | null;
  voucherApprovalRequired?: boolean | null;
  logoUrl?: string | null;
}

/** A member as the console's member directory lists it (`MemberProfile`). */
export interface MemberProfileView {
  id: string;
  displayName?: string | null;
  email?: string | null;
  phoneNumber?: string | null;
  status?: string | null;
  externalMemberId?: string | null;
  joinedAt?: string | null;
}

export interface MemberPageView {
  items: MemberProfileView[];
  nextCursor: string | null;
}

export interface MemberDetailView extends MemberProfileView {
  balance: CreditBalanceSnapshot;
}

/** A webhook endpoint as the console lists it. Core never returns its signing secret in a list. */
export interface WebhookEndpointView {
  id: string;
  url: string;
  description?: string | null;
  status?: string | null;
  createdAt?: string | null;
}

export interface WebhookDeliveryView {
  id: string;
  endpointId?: string | null;
  eventType?: string | null;
  status?: string | null;
  attemptCount?: number | null;
  nextAttemptAt?: string | null;
  lastResponseStatus?: number | null;
  lastError?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

/** A refund policy version (`VoucherRefundPolicyDto`). */
export interface RefundPolicyVersionView extends RefundPolicyView {
  version: number;
}

export interface StaffView {
  id: string;
  fullName?: string | null;
  email?: string | null;
  persona?: string | null;
  status?: string | null;
}

/** An invitation as the console lists it. The invitation token is only returned when it is created. */
export interface InvitationView {
  id: string;
  email?: string | null;
  persona?: string | null;
  status?: string | null;
  expiresAt?: string | null;
}

export interface MemberSearch {
  q?: string;
  externalMemberId?: string;
  status?: 'ACTIVE' | 'BLOCKED';
  limit?: number;
  cursor?: string;
}

/** Reads only the console client offers (OCT-294, OCT-310). A tool whose read is missing is not offered. */
export interface ConsoleReads {
  getConnection(options?: RequestOptions): Promise<ConnectionInfo>;
  getRefundPolicy(options?: RequestOptions): Promise<RefundPolicyView>;
  listApiKeys(options?: RequestOptions): Promise<ApiKeyView[]>;
  getOrganization(options?: RequestOptions): Promise<OrganizationView>;
  findMembers(search: MemberSearch, options?: RequestOptions): Promise<MemberPageView>;
  getMember(memberId: string, options?: RequestOptions): Promise<MemberDetailView>;
  consoleVouchers(options?: RequestOptions): Promise<VoucherDto[]>;
  consoleVoucher(voucherId: string, options?: RequestOptions): Promise<VoucherDto>;
  consoleVoucherBatches(includeArchived: boolean, options?: RequestOptions): Promise<VoucherBatchDto[]>;
  consoleVoucherBatch(batchId: string, options?: RequestOptions): Promise<VoucherBatchDetailDto>;
  getBudget(options?: RequestOptions): Promise<IssuanceBudgetDto>;
  consoleWebhookEndpoints(options?: RequestOptions): Promise<WebhookEndpointView[]>;
  consoleWebhookDeliveries(options?: RequestOptions): Promise<WebhookDeliveryView[]>;
  getRefundPolicyHistory(
    page: { limit: number; beforeVersion?: number },
    options?: RequestOptions,
  ): Promise<RefundPolicyVersionView[]>;
  listStaff(options?: RequestOptions): Promise<StaffView[]>;
  listInvitations(options?: RequestOptions): Promise<InvitationView[]>;
}

/** The member reads `get_member` uses besides `getMember`, which every Core client has. */
interface MemberActivityReads {
  listTransactions(
    memberId: string,
    options?: RequestOptions & { limit?: number; cursor?: string },
  ): Promise<LoyaltyTransactionPage>;
  listMemberVouchers(memberId: string, options?: RequestOptions): Promise<VoucherOwnershipDto[]>;
}

/** Tools that read the signed-in user's console routes; only the console client (`serve-http`) has them. */
export type ConsoleToolName =
  | 'get_connection'
  | 'get_refund_policy'
  | 'list_api_keys'
  | 'get_organization'
  | 'find_member'
  | 'get_member'
  | 'list_vouchers'
  | 'get_voucher'
  | 'list_voucher_batches'
  | 'get_voucher_batch'
  | 'get_budget'
  | 'list_webhook_endpoints'
  | 'list_webhook_deliveries'
  | 'get_refund_policy_history'
  | 'list_staff'
  | 'list_invitations';

/** The read each console tool needs from the client. */
export const CONSOLE_READ: Record<ConsoleToolName, keyof ConsoleReads> = {
  get_connection: 'getConnection',
  get_refund_policy: 'getRefundPolicy',
  list_api_keys: 'listApiKeys',
  get_organization: 'getOrganization',
  find_member: 'findMembers',
  get_member: 'getMember',
  list_vouchers: 'consoleVouchers',
  get_voucher: 'consoleVoucher',
  list_voucher_batches: 'consoleVoucherBatches',
  get_voucher_batch: 'consoleVoucherBatch',
  get_budget: 'getBudget',
  list_webhook_endpoints: 'consoleWebhookEndpoints',
  list_webhook_deliveries: 'consoleWebhookDeliveries',
  get_refund_policy_history: 'getRefundPolicyHistory',
  list_staff: 'listStaff',
  list_invitations: 'listInvitations',
};

export const CONSOLE_TOOLS = Object.keys(CONSOLE_READ) as ConsoleToolName[];

// -------------------------------------------------------------------------------------------------
// Inputs and answers
// -------------------------------------------------------------------------------------------------

const EMPTY_INPUT = z.object({}).strict();
const VOUCHER_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'PAUSED', 'EXPIRED', 'DEPLETED', 'ARCHIVED'] as const;

const MEMBER_PROFILE = z.object({
  memberId: z.string(),
  displayName: nullableString,
  email: nullableString,
  phoneNumber: nullableString,
  status: nullableString.describe('ACTIVE or BLOCKED'),
  posId: nullableString.describe("The member's id in the merchant's own system (POS or CRM)"),
  joinedAt: nullableString,
});

function profileOf(member: MemberProfileView): z.infer<typeof MEMBER_PROFILE> {
  return {
    memberId: member.id,
    displayName: orNull(member.displayName),
    email: orNull(member.email),
    phoneNumber: orNull(member.phoneNumber),
    status: orNull(member.status),
    posId: orNull(member.externalMemberId),
    joinedAt: orNull(member.joinedAt),
  };
}

const VOUCHER_SUMMARY = z.object({
  voucherId: z.string(),
  code: nullableString,
  title: nullableString,
  status: nullableString.describe(`One of ${VOUCHER_STATUSES.join(', ')}`),
  publishStatus: nullableString.describe('NOT_PUBLISHED, PUBLISHING, PUBLISHED or FAILED (on-chain terms)'),
  pointsCost: nullableNumber,
  discountType: nullableString,
  discountValue: nullableString,
  totalSupply: nullableNumber.describe('Null is unlimited'),
  claimedCount: nullableNumber,
  remainingSupply: nullableNumber.describe('Null is unlimited'),
  startsAt: nullableString,
  expiresAt: nullableString,
  batchId: nullableString,
  approvalStatus: nullableString.describe('The latest approval request: PENDING, APPROVED, REJECTED or WITHDRAWN'),
});

function voucherSummaryOf(voucher: VoucherDto): z.infer<typeof VOUCHER_SUMMARY> {
  const total = orNull(voucher.totalSupply);
  const claimed = orNull(voucher.claimedCount);
  return {
    voucherId: voucher.id,
    code: orNull(voucher.code),
    title: orNull(voucher.title),
    status: orNull(voucher.status),
    publishStatus: orNull(voucher.publishStatus),
    pointsCost: orNull(voucher.pointsCost),
    discountType: orNull(voucher.discountType),
    discountValue: orNull(voucher.discountValue),
    totalSupply: total,
    claimedCount: claimed,
    remainingSupply: total === null ? null : Math.max(0, total - (claimed ?? 0)),
    startsAt: orNull(voucher.startsAt),
    expiresAt: orNull(voucher.expiresAt),
    batchId: orNull(voucher.batchId),
    approvalStatus: orNull(voucher.approval?.status),
  };
}

const VOUCHER_DETAIL = VOUCHER_SUMMARY.extend({
  description: nullableString,
  terms: z.record(z.string(), z.unknown()).nullable().describe('What the customer gets, as the merchant wrote it'),
  perMemberLimit: nullableNumber.describe('Null is no limit'),
  validForDays: nullableNumber.describe("Days a claimed voucher stays valid; null means until the voucher's expiry"),
  approval: z
    .object({
      status: nullableString,
      submittedAt: nullableString,
      reviewedAt: nullableString,
      reason: nullableString.describe('Why an Owner rejected it'),
    })
    .nullable(),
  createdAt: nullableString,
  updatedAt: nullableString,
});

function voucherDetailOf(voucher: VoucherDto): z.infer<typeof VOUCHER_DETAIL> {
  const approval = voucher.approval;
  return {
    ...voucherSummaryOf(voucher),
    description: orNull(voucher.description),
    terms: orNull(voucher.terms),
    perMemberLimit: orNull(voucher.perMemberLimit),
    validForDays: orNull(voucher.validForDays),
    approval: approval
      ? {
          status: orNull(approval.status),
          submittedAt: orNull(approval.submittedAt),
          reviewedAt: orNull(approval.reviewedAt),
          reason: orNull(approval.reason),
        }
      : null,
    createdAt: orNull(voucher.createdAt),
    updatedAt: orNull(voucher.updatedAt),
  };
}

const BATCH = z.object({
  batchId: z.string(),
  name: nullableString,
  source: nullableString.describe('CONSOLE (CSV import) or API'),
  createdAt: nullableString,
  archivedAt: nullableString,
  statusCounts: z.record(z.string(), z.number()).describe('How many of its vouchers are in each status'),
});

function batchOf(batch: VoucherBatchDto): z.infer<typeof BATCH> {
  const counts: Record<string, number> = {};
  for (const [status, count] of Object.entries(batch.statusCounts ?? {})) {
    if (typeof count === 'number') counts[status] = count;
  }
  return {
    batchId: batch.id,
    name: orNull(batch.name),
    source: orNull(batch.source),
    createdAt: orNull(batch.createdAt),
    archivedAt: orNull(batch.archivedAt),
    statusCounts: counts,
  };
}

// -------------------------------------------------------------------------------------------------
// Registration
// -------------------------------------------------------------------------------------------------

/** The console reads (OCT-294, OCT-310). `allowed` already holds only the tools the client can serve. */
export function registerConsoleTools<Name extends string>(
  server: McpServer,
  core: Partial<ConsoleReads> & MemberActivityReads,
  allowed: ReadonlySet<string>,
  project?: Projection<Name>,
) {
  const projection = project as Projection<string> | undefined;
  const has = (tool: ConsoleToolName) => allowed.has(tool) && typeof core[CONSOLE_READ[tool]] === 'function';
  // Each method is bound once: `has` checked it exists.
  const call = <K extends keyof ConsoleReads>(key: K): ConsoleReads[K] =>
    (core[key] as unknown as (...args: unknown[]) => unknown).bind(core) as ConsoleReads[K];

  if (has('get_connection')) {
    const getConnection = call('getConnection');
    registerRead(
      server,
      'get_connection',
      {
        description:
          'Show which OctaP organization this session is connected to, the persona (Business Owner or ' +
          'Business Developer), the signed-in user, and when the sign-in expires. Every other tool reads ' +
          'this organization only.',
        input: EMPTY_INPUT,
        output: z.object({
          organization: z.object({ id: z.string(), name: z.string(), slug: z.string() }),
          persona: z.string(),
          signedInAs: z.string(),
          expiresAt: z.string(),
        }),
        run: async (_args, signal) => {
          const connection = await getConnection({ signal });
          return {
            organization: {
              id: connection.organization.id,
              name: connection.organization.name,
              slug: connection.organization.slug,
            },
            persona: connection.persona,
            signedInAs: connection.signedInAs,
            expiresAt: connection.expiresAt,
          };
        },
      },
      projection,
    );
  }

  if (has('get_organization')) {
    const getOrganization = call('getOrganization');
    registerRead(
      server,
      'get_organization',
      {
        description:
          "Read the connected organization's profile: display and legal name, type, status, and whether new " +
          "vouchers need an Owner's approval before they go live. Tax and identity numbers are never returned.",
        input: EMPTY_INPUT,
        output: z.object({
          organizationId: z.string(),
          name: z.string(),
          slug: z.string(),
          legalName: nullableString,
          organizationType: nullableString,
          status: nullableString,
          voucherApprovalRequired: z.boolean().nullable(),
          logoUrl: nullableString,
        }),
        run: async (_args, signal) => {
          const org = await getOrganization({ signal });
          return {
            organizationId: org.id,
            name: org.name,
            slug: org.slug,
            legalName: orNull(org.legalName),
            organizationType: orNull(org.organizationType),
            status: orNull(org.status),
            voucherApprovalRequired: orNull(org.voucherApprovalRequired),
            logoUrl: orNull(org.logoUrl),
          };
        },
      },
      projection,
    );
  }

  if (has('find_member')) {
    const findMembers = call('findMembers');
    registerRead(
      server,
      'find_member',
      {
        description:
          "Find members of the organization by name, email or phone number (query), by the merchant's own " +
          'member id (posId), or by status. Returns their member ids for the other member tools, a page at ' +
          'a time: pass nextCursor back as cursor for the next page.',
        input: z
          .object({
            query: z.string().trim().min(1).max(100).optional().describe('Part of a name, email or phone number'),
            posId: z.string().trim().min(1).max(100).optional().describe("The member's id in the POS or CRM"),
            status: z.enum(['ACTIVE', 'BLOCKED']).optional(),
            limit: z.number().int().min(1).max(50).default(20).describe('Members per page (1-50, default 20)'),
            cursor: z.string().min(1).max(500).optional().describe('nextCursor of the previous page'),
          })
          .strict(),
        output: z.object({ members: z.array(MEMBER_PROFILE), nextCursor: nullableString }),
        run: async (args, signal) => {
          const page = await findMembers(
            {
              ...(args.query ? { q: args.query } : {}),
              ...(args.posId ? { externalMemberId: args.posId } : {}),
              ...(args.status ? { status: args.status } : {}),
              limit: args.limit ?? 20,
              ...(args.cursor ? { cursor: args.cursor } : {}),
            },
            { signal },
          );
          return { members: page.items.map(profileOf), nextCursor: orNull(page.nextCursor) };
        },
      },
      projection,
    );
  }

  if (has('get_member')) {
    const getMember = call('getMember');
    const listTransactions = core.listTransactions.bind(core);
    const listMemberVouchers = core.listMemberVouchers.bind(core);
    registerRead(
      server,
      'get_member',
      {
        description:
          'Read one member: profile, status and points balance, and optionally their most recent transactions ' +
          'and the vouchers they hold, in one call. Use find_member first when you only have a name, email, ' +
          'phone or POS id. Voucher serial codes are never returned.',
        input: z
          .object({
            memberId: z.string().uuid().describe('From find_member'),
            include: z
              .array(z.enum(['transactions', 'vouchers']))
              .max(2)
              .default([])
              .describe('Also read recent transactions and/or vouchers held'),
            limit: z
              .number()
              .int()
              .min(1)
              .max(20)
              .default(5)
              .describe('How many transactions and vouchers to include (1-20, default 5)'),
          })
          .strict(),
        output: z.object({
          member: MEMBER_PROFILE,
          balance: BALANCE,
          recentTransactions: z.array(TRANSACTION).nullable().describe('Null unless asked for'),
          vouchers: z.array(OWNERSHIP).nullable().describe('Null unless asked for; newest first'),
        }),
        notFound: 'No member with this id in the connected organization. Use find_member to look them up.',
        run: async (args, signal) => {
          const include = new Set(args.include ?? []);
          const limit = args.limit ?? 5;
          const [detail, transactions, vouchers] = await Promise.all([
            getMember(args.memberId, { signal }),
            include.has('transactions') ? listTransactions(args.memberId, { limit, signal }) : null,
            include.has('vouchers') ? listMemberVouchers(args.memberId, { signal }) : null,
          ]);
          return {
            member: profileOf(detail),
            balance: balanceOf(detail.balance ?? {}, detail.id),
            recentTransactions: transactions ? transactions.items.map(transactionOf) : null,
            // Core's route has no limit yet (OCT-312), so the newest are kept here.
            vouchers: vouchers ? vouchers.slice(0, limit).map(ownershipOf) : null,
          };
        },
      },
      projection,
    );
  }

  if (has('list_vouchers')) {
    const consoleVouchers = call('consoleVouchers');
    registerRead(
      server,
      'list_vouchers',
      {
        description:
          "List the organization's reward catalog: each voucher's status, points cost, discount, supply left " +
          'and dates. Filter by status (e.g. PENDING_APPROVAL for vouchers waiting for an Owner, DRAFT for ' +
          'ones not live yet) or by words in the title or code.',
        input: z
          .object({
            status: z.enum(VOUCHER_STATUSES).optional(),
            query: z.string().trim().min(1).max(100).optional().describe('Words in the title or code'),
            limit: z.number().int().min(1).max(50).default(20).describe('Vouchers to return (1-50, default 20)'),
          })
          .strict(),
        output: z.object({
          vouchers: z.array(VOUCHER_SUMMARY),
          matching: z.number().describe('How many vouchers match, before the limit'),
        }),
        run: async (args, signal) => {
          const needle = args.query?.toLowerCase();
          const matching = (await consoleVouchers({ signal })).filter(
            (voucher) =>
              (!args.status || voucher.status === args.status) &&
              (!needle ||
                voucher.title?.toLowerCase().includes(needle) ||
                voucher.code?.toLowerCase().includes(needle)),
          );
          return { vouchers: matching.slice(0, args.limit ?? 20).map(voucherSummaryOf), matching: matching.length };
        },
      },
      projection,
    );
  }

  if (has('get_voucher')) {
    const consoleVoucher = call('consoleVoucher');
    registerRead(
      server,
      'get_voucher',
      {
        description:
          'Read one voucher in full: what the customer gets (terms), limits, dates, supply left, and its ' +
          'latest approval request (status, and the reason if an Owner rejected it).',
        input: z.object({ voucherId: z.string().uuid().describe('From list_vouchers') }).strict(),
        output: VOUCHER_DETAIL,
        notFound: 'No voucher with this id in the connected organization. Use list_vouchers to look it up.',
        run: async (args, signal) => voucherDetailOf(await consoleVoucher(args.voucherId, { signal })),
      },
      projection,
    );
  }

  if (has('list_voucher_batches')) {
    const consoleVoucherBatches = call('consoleVoucherBatches');
    registerRead(
      server,
      'list_voucher_batches',
      {
        description:
          'List the voucher batches (vouchers imported together from a CSV or created together through the ' +
          'API), newest first, with how many of their vouchers are in each status.',
        input: z
          .object({
            includeArchived: z.boolean().default(false).describe('Also list archived batches'),
          })
          .strict(),
        output: z.object({ batches: z.array(BATCH) }),
        run: async (args, signal) => ({
          batches: (await consoleVoucherBatches(args.includeArchived ?? false, { signal })).map(batchOf),
        }),
      },
      projection,
    );
  }

  if (has('get_voucher_batch')) {
    const consoleVoucherBatch = call('consoleVoucherBatch');
    registerRead(
      server,
      'get_voucher_batch',
      {
        description: "Read one voucher batch and every voucher in it, with each voucher's status and supply.",
        input: z.object({ batchId: z.string().uuid().describe('From list_voucher_batches') }).strict(),
        output: BATCH.extend({ vouchers: z.array(VOUCHER_SUMMARY) }),
        notFound: 'No voucher batch with this id in the connected organization. Use list_voucher_batches.',
        run: async (args, signal) => {
          const batch = await consoleVoucherBatch(args.batchId, { signal });
          return { ...batchOf(batch), vouchers: (batch.vouchers ?? []).map(voucherSummaryOf) };
        },
      },
      projection,
    );
  }

  if (has('get_budget')) {
    const getBudget = call('getBudget');
    registerRead(
      server,
      'get_budget',
      {
        description:
          'Read how many more points the organization can issue: remaining, capacity, the share used, a ' +
          'low-budget warning (80 or 95 percent), and recent top-ups. Points, not money.',
        input: EMPTY_INPUT,
        output: z.object({
          remaining: nullableNumber,
          capacity: nullableNumber.describe('The initial budget plus every top-up'),
          initialBudget: nullableNumber,
          usedPercent: nullableNumber,
          warningThreshold: nullableNumber.describe('80 or 95 once a shard has used that share, otherwise null'),
          lowestShardRemaining: nullableNumber.describe(
            'Earns can fail when one shard runs out, even while the total is above zero',
          ),
          recentTopUps: z.array(
            z.object({ amount: nullableNumber, status: nullableString, createdAt: nullableString }),
          ),
          observedAt: nullableString,
        }),
        run: async (_args, signal) => {
          const budget = await getBudget({ signal });
          const capacity = orNull(budget.capacity);
          const remaining = orNull(budget.remaining);
          const shards = budget.shards ?? [];
          return {
            remaining,
            capacity,
            initialBudget: orNull(budget.initialBudget),
            usedPercent:
              capacity && remaining !== null ? Math.round(((capacity - remaining) / capacity) * 1000) / 10 : null,
            warningThreshold: orNull(budget.warningThreshold),
            lowestShardRemaining: shards.length ? Math.min(...shards.map((shard) => shard.remaining)) : null,
            recentTopUps: (budget.recentTopUps ?? []).map((topUp) => ({
              amount: orNull(topUp.amount),
              status: orNull(topUp.status),
              createdAt: orNull(topUp.createdAt),
            })),
            observedAt: orNull(budget.observedAt),
          };
        },
      },
      projection,
    );
  }

  if (has('get_refund_policy')) {
    const getRefundPolicy = call('getRefundPolicy');
    registerRead(
      server,
      'get_refund_policy',
      {
        description:
          "Read the organization's current voucher refund policy: which vouchers can be refunded (unused, " +
          'expired, redeemed), whether a refunded unused voucher goes back to stock, and the refund window in days.',
        input: EMPTY_INPUT,
        output: z.object({
          version: nullableNumber,
          allowUnused: z.boolean().nullable(),
          allowExpired: z.boolean().nullable(),
          allowRedeemed: z.boolean().nullable(),
          restockUnused: z.boolean().nullable(),
          refundWindowDays: nullableNumber,
          reason: nullableString,
          publishedAt: nullableString,
        }),
        run: async (_args, signal) => {
          const policy = await getRefundPolicy({ signal });
          return {
            version: orNull(policy.version),
            allowUnused: orNull(policy.allowUnused),
            allowExpired: orNull(policy.allowExpired),
            allowRedeemed: orNull(policy.allowRedeemed),
            restockUnused: orNull(policy.restockUnused),
            refundWindowDays: orNull(policy.refundWindowDays),
            reason: orNull(policy.reason),
            publishedAt: orNull(policy.createdAt),
          };
        },
      },
      projection,
    );
  }

  if (has('list_api_keys')) {
    const listApiKeys = call('listApiKeys');
    registerRead(
      server,
      'list_api_keys',
      {
        description:
          "List the organization's API keys: name, key prefix, scopes (read, or read and write), status, " +
          'when each was created and last used. The keys themselves are never returned.',
        input: EMPTY_INPUT,
        output: z.object({
          keys: z.array(
            z.object({
              name: nullableString,
              keyPrefix: nullableString,
              scopes: z.array(z.string()),
              status: nullableString,
              createdAt: nullableString,
              lastUsedAt: nullableString,
            }),
          ),
        }),
        // Whitelist the fields, so nothing Core adds later passes through unreviewed.
        run: async (_args, signal) => ({
          keys: (await listApiKeys({ signal })).map((key) => ({
            name: orNull(key.name),
            keyPrefix: orNull(key.keyPrefix),
            scopes: key.scopes ?? [],
            status: orNull(key.status),
            createdAt: orNull(key.createdAt),
            lastUsedAt: orNull(key.lastUsedAt),
          })),
        }),
      },
      projection,
    );
  }

  if (has('list_webhook_endpoints')) {
    const consoleWebhookEndpoints = call('consoleWebhookEndpoints');
    registerRead(
      server,
      'list_webhook_endpoints',
      {
        description:
          "List the organization's webhook endpoints: where events are sent and whether each is enabled. " +
          'Signing secrets are never returned, and query strings are hidden from the URLs.',
        input: EMPTY_INPUT,
        output: z.object({
          endpoints: z.array(
            z.object({
              endpointId: z.string(),
              url: z.string().describe('Without its query string, which may carry a token'),
              description: nullableString,
              status: nullableString.describe('ACTIVE or DISABLED'),
              createdAt: nullableString,
            }),
          ),
        }),
        run: async (_args, signal) => ({
          endpoints: (await consoleWebhookEndpoints({ signal })).map((endpoint) => ({
            endpointId: endpoint.id,
            url: withoutQuery(endpoint.url),
            description: orNull(endpoint.description),
            status: orNull(endpoint.status),
            createdAt: orNull(endpoint.createdAt),
          })),
        }),
      },
      projection,
    );
  }

  if (has('list_webhook_deliveries')) {
    const consoleWebhookDeliveries = call('consoleWebhookDeliveries');
    registerRead(
      server,
      'list_webhook_deliveries',
      {
        description:
          'List recent webhook deliveries, newest first: the event, its status (PENDING while retrying, DELIVERED, ' +
          'or DEAD_LETTER once retries ran out), attempts, the last HTTP status and error, and the next retry. Use it to answer ' +
          '"why did my webhook fail?".',
        input: z
          .object({
            status: z.enum(['PENDING', 'DELIVERED', 'DEAD_LETTER']).optional(),
            endpointId: z.string().uuid().optional().describe('From list_webhook_endpoints'),
            limit: z.number().int().min(1).max(50).default(20).describe('Deliveries to return (1-50, default 20)'),
          })
          .strict(),
        output: z.object({
          deliveries: z.array(
            z.object({
              deliveryId: z.string(),
              endpointId: nullableString,
              eventType: nullableString,
              status: nullableString,
              attemptCount: nullableNumber,
              lastResponseStatus: nullableNumber,
              lastError: nullableString,
              nextAttemptAt: nullableString,
              createdAt: nullableString,
            }),
          ),
          matching: z.number().describe('How many deliveries match, before the limit'),
        }),
        run: async (args, signal) => {
          const matching = (await consoleWebhookDeliveries({ signal })).filter(
            (delivery) =>
              (!args.status || delivery.status === args.status) &&
              (!args.endpointId || delivery.endpointId === args.endpointId),
          );
          return {
            deliveries: matching.slice(0, args.limit ?? 20).map((delivery) => ({
              deliveryId: delivery.id,
              endpointId: orNull(delivery.endpointId),
              eventType: orNull(delivery.eventType),
              status: orNull(delivery.status),
              attemptCount: orNull(delivery.attemptCount),
              lastResponseStatus: orNull(delivery.lastResponseStatus),
              // Bounded: it is the receiver's error text, not ours.
              lastError: delivery.lastError ? delivery.lastError.slice(0, 300) : null,
              nextAttemptAt: orNull(delivery.nextAttemptAt),
              createdAt: orNull(delivery.createdAt),
            })),
            matching: matching.length,
          };
        },
      },
      projection,
    );
  }

  if (has('get_refund_policy_history')) {
    const getRefundPolicyHistory = call('getRefundPolicyHistory');
    registerRead(
      server,
      'get_refund_policy_history',
      {
        description:
          'List earlier versions of the voucher refund policy, newest first, with the reason given for each ' +
          'change. Pass nextBeforeVersion back as beforeVersion for older versions.',
        input: z
          .object({
            limit: z.number().int().min(1).max(50).default(10).describe('Versions to return (1-50, default 10)'),
            beforeVersion: z.number().int().min(1).optional(),
          })
          .strict(),
        output: z.object({
          versions: z.array(
            z.object({
              version: z.number(),
              allowUnused: z.boolean().nullable(),
              allowExpired: z.boolean().nullable(),
              allowRedeemed: z.boolean().nullable(),
              restockUnused: z.boolean().nullable(),
              refundWindowDays: nullableNumber,
              reason: nullableString,
              publishedAt: nullableString,
            }),
          ),
          nextBeforeVersion: nullableNumber,
        }),
        run: async (args, signal) => {
          const limit = args.limit ?? 10;
          const rows = await getRefundPolicyHistory(
            { limit, ...(args.beforeVersion ? { beforeVersion: args.beforeVersion } : {}) },
            { signal },
          );
          return {
            versions: rows.map((policy) => ({
              version: policy.version,
              allowUnused: orNull(policy.allowUnused),
              allowExpired: orNull(policy.allowExpired),
              allowRedeemed: orNull(policy.allowRedeemed),
              restockUnused: orNull(policy.restockUnused),
              refundWindowDays: orNull(policy.refundWindowDays),
              reason: orNull(policy.reason),
              publishedAt: orNull(policy.createdAt),
            })),
            nextBeforeVersion: rows.length === limit ? rows[rows.length - 1].version : null,
          };
        },
      },
      projection,
    );
  }

  if (has('list_staff')) {
    const listStaff = call('listStaff');
    registerRead(
      server,
      'list_staff',
      {
        description:
          'List who can sign in to the console for this organization: name, email, role (Owner or Business ' +
          'Developer) and status (active or suspended).',
        input: EMPTY_INPUT,
        output: z.object({
          staff: z.array(
            z.object({
              userId: z.string(),
              fullName: nullableString,
              email: nullableString,
              persona: nullableString,
              status: nullableString,
            }),
          ),
        }),
        run: async (_args, signal) => ({
          staff: (await listStaff({ signal })).map((person) => ({
            userId: person.id,
            fullName: orNull(person.fullName),
            email: orNull(person.email),
            persona: orNull(person.persona),
            status: orNull(person.status),
          })),
        }),
      },
      projection,
    );
  }

  if (has('list_invitations')) {
    const listInvitations = call('listInvitations');
    registerRead(
      server,
      'list_invitations',
      {
        description:
          'List invitations to join the console: email, role, status (pending, accepted, revoked or expired) ' +
          'and expiry. Invitation links are never returned.',
        input: EMPTY_INPUT,
        output: z.object({
          invitations: z.array(
            z.object({
              invitationId: z.string(),
              email: nullableString,
              persona: nullableString,
              status: nullableString,
              expiresAt: nullableString,
            }),
          ),
        }),
        run: async (_args, signal) => ({
          invitations: (await listInvitations({ signal })).map((invitation) => ({
            invitationId: invitation.id,
            email: orNull(invitation.email),
            persona: orNull(invitation.persona),
            status: orNull(invitation.status),
            expiresAt: orNull(invitation.expiresAt),
          })),
        }),
      },
      projection,
    );
  }
}

/** A URL without its query string or fragment, which may carry a token; the input unchanged if unparsable. */
function withoutQuery(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split(/[?#]/)[0];
  }
}
