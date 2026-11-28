import type { McpServer } from '@modelcontextprotocol/server';
import type { VoucherDto } from '@octap/sdk';
import * as z from 'zod/v4';
import type { PreparedChange } from './console-client.js';
import { VOUCHER_DETAIL, voucherDetailOf, type ConsoleReads } from './console-tools.js';
import { combineSignal, isOctaApiError, nullableString, result, type ToolExtra } from './tool-kit.js';

interface RequestOptions {
  signal?: AbortSignal;
}

/** A change to prepare: the console route, its body, and what it does in words. */
export interface ChangeInput {
  method: PreparedChange['method'];
  path: string;
  body: Record<string, unknown>;
  summary: string;
}

/**
 * What the write tools need from Core (OCT-314). Preparing stores the change and changes nothing;
 * applying sends it with its confirmation id, and Core makes it once.
 */
export interface ConsoleWrites {
  /** A console path of the connected organization: `organizationPath('/vouchers')`. */
  organizationPath(suffix?: string): string;
  /** Reads one voucher, to describe it before changing it. */
  consoleVoucher(voucherId: string, options?: RequestOptions): Promise<VoucherDto>;
  prepareChange(change: ChangeInput, options?: RequestOptions): Promise<PreparedChange>;
  getChange(confirmationId: string, options?: RequestOptions): Promise<PreparedChange>;
  applyChange(change: PreparedChange, options?: RequestOptions): Promise<unknown>;
}

export type WriteToolName =
  | 'create_voucher'
  | 'update_voucher'
  | 'submit_voucher'
  | 'withdraw_voucher'
  | 'activate_voucher'
  | 'pause_voucher'
  | 'approve_voucher'
  | 'reject_voucher'
  | 'import_vouchers'
  | 'activate_voucher_batch'
  | 'pause_voucher_batch'
  | 'resume_voucher_batch'
  | 'archive_voucher_batch'
  | 'update_member_details'
  | 'block_member'
  | 'unblock_member'
  | 'rename_api_key'
  | 'revoke_api_key'
  | 'set_refund_policy'
  | 'set_voucher_approval_required'
  | 'update_organization_display'
  | 'enable_webhook_endpoint'
  | 'disable_webhook_endpoint'
  | 'replay_webhook_delivery'
  | 'send_test_webhook'
  | 'confirm_change';

export const WRITE_TOOLS: WriteToolName[] = [
  'create_voucher',
  'update_voucher',
  'submit_voucher',
  'withdraw_voucher',
  'activate_voucher',
  'pause_voucher',
  'approve_voucher',
  'reject_voucher',
  'import_vouchers',
  'activate_voucher_batch',
  'pause_voucher_batch',
  'resume_voucher_batch',
  'archive_voucher_batch',
  'update_member_details',
  'block_member',
  'unblock_member',
  'rename_api_key',
  'revoke_api_key',
  'set_refund_policy',
  'set_voucher_approval_required',
  'update_organization_display',
  'enable_webhook_endpoint',
  'disable_webhook_endpoint',
  'replay_webhook_delivery',
  'send_test_webhook',
  'confirm_change',
];

const WRITE_METHODS: Array<keyof ConsoleWrites> = [
  'organizationPath',
  'consoleVoucher',
  'prepareChange',
  'getChange',
  'applyChange',
];

/** Whether a client can serve the write tools: a signed-in user's, not an API key's. */
export function canServeWrites(client: object): client is ConsoleWrites {
  return WRITE_METHODS.every((method) => typeof (client as Record<string, unknown>)[method] === 'function');
}

/**
 * Preparing changes nothing: Core only stores the change for the user to confirm, so these are
 * read-only to the host. Applying is the write, and it says so, so a host asks the user first.
 */
const PREPARE = { readOnlyHint: true, openWorldHint: true } as const;
const APPLY = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true } as const;

const VOUCHER_ID = z.string().uuid().describe('From list_vouchers or create_voucher');
const DATE = z
  .string()
  .datetime({ offset: true })
  .describe('ISO 8601 with a time zone, e.g. 2026-12-31T23:59:59+07:00');

/** The fields a merchant sets on a voucher. `terms` is left out: it goes on-chain for good. */
const VOUCHER_FIELDS = {
  title: z.string().trim().min(1).max(200).describe('What customers see, e.g. "10% off any drink"'),
  description: z.string().trim().max(2000).optional(),
  pointsCost: z.number().int().min(0).describe('Points a member spends to claim it; 0 for a free reward'),
  discountType: z.enum(['PERCENTAGE', 'FIXED_AMOUNT', 'FREE_ITEM']),
  discountValue: z
    .string()
    .trim()
    .regex(/^\d{1,12}(\.\d{1,2})?$/)
    .optional()
    .describe(
      'A positive number: "10" for 10% off, "50000" for 50,000 VND off. Leave it out for FREE_ITEM; say what the item is in the title',
    ),
  totalSupply: z
    .number()
    .int()
    .min(1)
    .nullable()
    .optional()
    .describe('How many can be issued in all; null is no limit'),
  perMemberLimit: z
    .number()
    .int()
    .min(1)
    .nullable()
    .optional()
    .describe('How many one member may hold; null is no limit'),
  startsAt: DATE.nullable().optional(),
  expiresAt: DATE.nullable().optional().describe('When claims close; at least a day after it is activated'),
  validForDays: z
    .number()
    .int()
    .min(1)
    .max(3650)
    .nullable()
    .optional()
    .describe("Days each customer's voucher stays usable after they get it; null: until expiresAt"),
};

const CREATE_INPUT = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{1,64}$/)
      .describe('A unique code in this organization, e.g. COFFEE10'),
    ...VOUCHER_FIELDS,
  })
  .strict();

const UPDATE_INPUT = z
  .object({
    voucherId: VOUCHER_ID,
    changes: z
      .object(Object.fromEntries(Object.entries(VOUCHER_FIELDS).map(([key, schema]) => [key, schema.optional()])))
      .strict()
      .refine((value) => Object.keys(value).length > 0, 'Change at least one field'),
  })
  .strict();

const VOUCHER_ONLY = z.object({ voucherId: VOUCHER_ID }).strict();

const PREPARED = z.object({
  confirmationId: z.string(),
  summary: z.string().describe('Show this to the user, word for word, and ask whether to go ahead'),
  expiresAt: z.string().describe('The confirmation expires then (5 minutes); prepare it again after'),
  nextStep: z.string(),
});

const APPLIED = z.object({
  done: z.literal(true),
  summary: z.string().describe('What was changed'),
  voucher: VOUCHER_DETAIL.nullable().describe('The voucher as it is now, when the change was to one voucher'),
  outcomes: z
    .array(z.object({ code: nullableString, result: z.string(), reason: nullableString }))
    .nullable()
    .describe("Each voucher's result when the change was to a batch: created, conflict, error, activated, failed…"),
});

const NEXT_STEP =
  'Nothing has changed yet. Show the summary to the user and ask them to confirm. Only if they clearly ' +
  'agree, call confirm_change with this confirmationId. If they decline or want changes, do not call it.';

/**
 * The write tools (OCT-314). Every change takes two calls: the tool named for it prepares the change
 * and returns a summary and a confirmation id, changing nothing; `confirm_change` makes it, once the
 * user agreed. Core checks the persona, the organization and the confirmation again on the write, so
 * these tools hold no authority: a wrong persona map can show a tool Core then refuses.
 */
export function registerWriteTools(
  server: McpServer,
  core: ConsoleWrites & Partial<ConsoleReads>,
  allowed: ReadonlySet<string>,
) {
  const prepare = <Args>(
    name: WriteToolName,
    description: string,
    input: z.ZodType<Args>,
    build: (args: Args, signal: AbortSignal) => Promise<ChangeInput>,
    /** The reads the tool describes the change with; it is offered only when the client has them. */
    needs: Array<keyof ConsoleReads> = [],
  ) => {
    if (!allowed.has(name) || !needs.every((read) => typeof core[read] === 'function')) return;
    server.registerTool(
      name,
      {
        description: `${description} This only prepares the change: it returns a summary to show the user and a confirmationId. Nothing changes until confirm_change.`,
        inputSchema: input,
        outputSchema: PREPARED,
        annotations: PREPARE,
      },
      async (args: Args, extra: ToolExtra) => {
        try {
          const signal = combineSignal(extra);
          const change = await core.prepareChange(await build(args, signal), { signal });
          return result(
            name,
            {
              confirmationId: change.confirmationId,
              summary: change.summary,
              expiresAt: change.expiresAt,
              nextStep: NEXT_STEP,
            },
            true,
          );
        } catch (error) {
          return writeError(name, error);
        }
      },
    );
  };

  const voucherLabel = (voucher: VoucherDto) => `"${voucher.title}" (${voucher.code}, now ${voucher.status})`;
  const voucherChange = async (
    voucherId: string,
    signal: AbortSignal,
    describe: (voucher: VoucherDto) => Omit<ChangeInput, 'path'> & { suffix?: string },
  ): Promise<ChangeInput> => {
    const voucher = await core.consoleVoucher(voucherId, { signal });
    const { suffix, ...change } = describe(voucher);
    return { ...change, path: core.organizationPath(`/vouchers/${encodeURIComponent(voucherId)}${suffix ?? ''}`) };
  };

  prepare(
    'create_voucher',
    'Create a new voucher as a DRAFT: customers cannot see or claim it until it is activated (or, for a ' +
      'Business Developer, submitted and approved by an Owner).',
    CREATE_INPUT,
    async (args) => ({
      method: 'POST',
      path: core.organizationPath('/vouchers'),
      body: definedOnly({ ...args, status: 'DRAFT' }),
      summary: `Create a draft voucher ${describeFields(args)}.`,
    }),
  );

  prepare(
    'update_voucher',
    "Change a voucher's fields. A Business Developer can change drafts only. Once a voucher is live, its " +
      'terms are fixed on-chain; only supply, per-member limit and dates may still change.',
    UPDATE_INPUT,
    async (args, signal) =>
      voucherChange(args.voucherId, signal, (voucher) => ({
        method: 'PATCH',
        body: definedOnly(args.changes),
        summary: `Change voucher ${voucherLabel(voucher)}: ${describeFields(args.changes)}.`,
      })),
  );

  prepare(
    'submit_voucher',
    'Send a draft voucher to an Owner for approval (Business Developer).',
    VOUCHER_ONLY,
    async (args, signal) =>
      voucherChange(args.voucherId, signal, (voucher) => ({
        method: 'POST',
        suffix: '/submit',
        body: {},
        summary: `Submit voucher ${voucherLabel(voucher)} to an Owner for approval.`,
      })),
  );

  prepare(
    'withdraw_voucher',
    'Take a voucher waiting for approval back to DRAFT.',
    VOUCHER_ONLY,
    async (args, signal) =>
      voucherChange(args.voucherId, signal, (voucher) => ({
        method: 'POST',
        suffix: '/withdraw',
        body: {},
        summary: `Withdraw voucher ${voucherLabel(voucher)} back to draft.`,
      })),
  );

  prepare(
    'activate_voucher',
    'Make a voucher live: publish a draft (its terms go on-chain and cannot change afterwards), or resume a ' +
      'paused one. An Owner may; Core refuses a Business Developer where approval is required.',
    VOUCHER_ONLY,
    async (args, signal) =>
      voucherChange(args.voucherId, signal, (voucher) => ({
        method: 'PATCH',
        // The voucher as the user saw it: Core refuses it (409) if it changed since, so no edit goes live
        // unseen. Required when an Owner activates while approval is on; ignored otherwise (OCT-324).
        body: { status: 'ACTIVE', expectedUpdatedAt: voucher.updatedAt },
        summary:
          voucher.status === 'PAUSED'
            ? `Resume voucher ${voucherLabel(voucher)}: members can claim it again.`
            : `Activate voucher ${voucherLabel(voucher)}: its terms are published on-chain and can't change ` +
              'afterwards, and members can claim it.',
      })),
  );

  prepare(
    'pause_voucher',
    'Pause a live voucher: members cannot claim it until it is resumed. Vouchers already claimed stay usable (Owner).',
    VOUCHER_ONLY,
    async (args, signal) =>
      voucherChange(args.voucherId, signal, (voucher) => ({
        method: 'PATCH',
        body: { status: 'PAUSED' },
        summary: `Pause voucher ${voucherLabel(voucher)}: members can't claim it until it is resumed.`,
      })),
  );

  prepare(
    'approve_voucher',
    'Approve a voucher waiting for approval: it is published and goes live (Owner).',
    VOUCHER_ONLY,
    async (args, signal) =>
      voucherChange(args.voucherId, signal, (voucher) => ({
        method: 'POST',
        suffix: '/approve',
        body: { approvalRequestId: pendingApproval(voucher) },
        summary: `Approve voucher ${voucherLabel(voucher)}: its terms are published on-chain and members can claim it.`,
      })),
  );

  prepare(
    'reject_voucher',
    'Reject a voucher waiting for approval, with a reason shown to whoever submitted it (Owner).',
    z
      .object({
        voucherId: VOUCHER_ID,
        reason: z.string().trim().min(1).max(500).describe('Why, shown to whoever submitted it'),
      })
      .strict(),
    async (args, signal) =>
      voucherChange(args.voucherId, signal, (voucher) => ({
        method: 'POST',
        suffix: '/reject',
        body: { approvalRequestId: pendingApproval(voucher), reason: args.reason },
        summary: `Reject voucher ${voucherLabel(voucher)} with the reason: "${args.reason}". It goes back to draft.`,
      })),
  );

  // --- Batches (OCT-303) ------------------------------------------------------------------------

  const batchOf = (batchId: string, signal: AbortSignal) => core.consoleVoucherBatch!(batchId, { signal });
  const batchLabel = (batch: { name?: string | null; id: string }) =>
    batch.name ? `"${batch.name}"` : `${batch.id.slice(0, 8)}…`;
  const batchPath = (batchId: string, action: string) =>
    core.organizationPath(`/voucher-batches/${encodeURIComponent(batchId)}/${action}`);
  const BATCH_ONLY = z.object({ batchId: z.string().uuid().describe('From list_voucher_batches') }).strict();

  prepare(
    'import_vouchers',
    'Import up to 100 vouchers as one draft batch, e.g. from a list the user pasted. Every voucher is a ' +
      'draft until the batch is activated. A code that already exists is reported, not overwritten (only a ' +
      'draft of an archived batch is replaced).',
    z
      .object({
        name: z.string().trim().max(120).optional().describe('A label, e.g. the file name or "Tet 2027"'),
        items: z.array(CREATE_INPUT).min(1).max(100),
      })
      .strict(),
    async (args) => ({
      method: 'POST',
      path: core.organizationPath('/voucher-batches'),
      body: definedOnly({ name: args.name, items: args.items.map((item) => definedOnly(item)) }),
      summary:
        `Import ${count(args.items.length, 'voucher')} as one draft batch${args.name ? ` "${args.name}"` : ''}: ` +
        args.items.map((item) => `${item.code} "${item.title}" (${item.pointsCost} points)`).join('; ') +
        '. A code that already exists is reported and left as it is.',
    }),
  );

  prepare(
    'activate_voucher_batch',
    "Activate a batch's draft and waiting vouchers. For an Owner they are published on-chain (terms can't " +
      'change afterwards) and go live; for a Business Developer, they go to an Owner for approval when ' +
      'approval is on.',
    BATCH_ONLY,
    async (args, signal) => {
      const batch = await batchOf(args.batchId, signal);
      const pending = batch.vouchers.filter(
        (voucher) => voucher.status === 'DRAFT' || voucher.status === 'PENDING_APPROVAL',
      );
      if (pending.length === 0)
        throw new WriteInputError(`Batch ${batchLabel(batch)} has no draft or waiting voucher to activate.`);
      return {
        method: 'POST',
        path: batchPath(args.batchId, 'activate'),
        // The vouchers as the user saw them: one changed since fails alone instead of going live unseen.
        body: { seen: pending.map((voucher) => ({ voucherId: voucher.id, updatedAt: voucher.updatedAt })) },
        summary:
          `Activate batch ${batchLabel(batch)}: ${count(pending.length, 'voucher')} (` +
          pending.map((voucher) => voucher.code).join(', ') +
          "). For an Owner, their terms are published on-chain and can't change afterwards, and members can claim them.",
      };
    },
    ['consoleVoucherBatch'],
  );

  const BATCH_ACTIONS = [
    [
      'pause_voucher_batch',
      'pause',
      'Pause every live voucher of a batch (Owner).',
      "members can't claim them until resumed",
    ],
    [
      'resume_voucher_batch',
      'resume',
      'Resume the paused vouchers of a batch (Owner).',
      'members can claim them again',
    ],
    [
      'archive_voucher_batch',
      'archive',
      'Archive a batch: it leaves the batch list. Live vouchers stay live.',
      'it leaves the batch list; live vouchers stay live',
    ],
  ] as const;
  for (const [name, action, description, effect] of BATCH_ACTIONS) {
    prepare(
      name,
      description,
      BATCH_ONLY,
      async (args, signal) => {
        const batch = await batchOf(args.batchId, signal);
        return {
          method: 'POST',
          path: batchPath(args.batchId, action),
          body: {},
          summary: `${action[0].toUpperCase()}${action.slice(1)} batch ${batchLabel(batch)}: ${effect}.`,
        };
      },
      ['consoleVoucherBatch'],
    );
  }

  // --- Members ----------------------------------------------------------------------------------

  const MEMBER = z.string().uuid().describe('From find_member');
  const memberChange = async (
    memberId: string,
    signal: AbortSignal,
    describe: (label: string, status: string | null | undefined) => Pick<ChangeInput, 'body' | 'summary'>,
  ): Promise<ChangeInput> => {
    const member = await core.getMember!(memberId, { signal });
    const label = member.displayName ? `${member.displayName} (${memberId.slice(0, 8)}…)` : memberId;
    return {
      method: 'PATCH',
      path: core.organizationPath(`/members/${encodeURIComponent(memberId)}`),
      ...describe(label, member.status),
    };
  };

  prepare(
    'update_member_details',
    "Change a member's POS id (externalMemberId) or metadata (Owner). Their name, email and phone are their " +
      'own and cannot be changed here.',
    z
      .object({
        memberId: MEMBER,
        externalMemberId: z.string().trim().min(1).max(128).nullable().optional().describe('null removes it'),
        metadata: z.record(z.string(), z.unknown()).optional().describe('Replaces the whole metadata object'),
      })
      .strict()
      .refine(
        (value) => value.externalMemberId !== undefined || value.metadata !== undefined,
        'Change at least one field',
      ),
    async (args, signal) =>
      memberChange(args.memberId, signal, (label) => ({
        body: definedOnly({ externalMemberId: args.externalMemberId, metadata: args.metadata }),
        summary:
          `Change member ${label}: ` +
          [
            args.externalMemberId !== undefined ? `POS id: ${args.externalMemberId ?? 'none'}` : null,
            args.metadata !== undefined ? `metadata: ${JSON.stringify(args.metadata)}` : null,
          ]
            .filter(Boolean)
            .join('; ') +
          '.',
      })),
    ['getMember'],
  );

  prepare(
    'block_member',
    'Block a member in this organization (Owner): they cannot earn, claim or redeem here until unblocked.',
    z.object({ memberId: MEMBER }).strict(),
    async (args, signal) =>
      memberChange(args.memberId, signal, (label) => ({
        body: { status: 'BLOCKED' },
        summary: `Block member ${label}: they can't earn, claim or redeem here until unblocked.`,
      })),
    ['getMember'],
  );

  prepare(
    'unblock_member',
    'Unblock a member blocked in this organization (Owner).',
    z.object({ memberId: MEMBER }).strict(),
    async (args, signal) =>
      memberChange(args.memberId, signal, (label, status) => {
        if (status !== 'BLOCKED')
          throw new WriteInputError(`Member ${label} is ${status ?? 'not blocked'}, not BLOCKED.`);
        return { body: { status: 'ACTIVE' }, summary: `Unblock member ${label}: they can take part again.` };
      }),
    ['getMember'],
  );

  // --- API keys: rename and revoke only. Creating one would put its secret in the conversation. ---

  const KEY_PREFIX = z.string().trim().min(4).max(64).describe('The keyPrefix from list_api_keys');
  const keyChange = async (
    keyPrefix: string,
    signal: AbortSignal,
    describe: (key: { name: string; scopes: string[] }) => Pick<ChangeInput, 'method' | 'body' | 'summary'>,
  ): Promise<ChangeInput> => {
    const key = (await core.listApiKeys!({ signal })).find((candidate) => candidate.keyPrefix === keyPrefix);
    if (!key?.id)
      throw new WriteInputError(`No API key with the prefix ${keyPrefix}. Use list_api_keys to look it up.`);
    return { ...describe(key), path: core.organizationPath(`/api-credentials/${encodeURIComponent(key.id)}`) };
  };

  prepare(
    'rename_api_key',
    'Rename an API key. A Business Developer may rename read-only keys only.',
    z.object({ keyPrefix: KEY_PREFIX, name: z.string().trim().min(1).max(100) }).strict(),
    async (args, signal) =>
      keyChange(args.keyPrefix, signal, (key) => ({
        method: 'PATCH',
        body: { name: args.name },
        summary: `Rename API key ${args.keyPrefix}… from "${key.name}" to "${args.name}".`,
      })),
    ['listApiKeys'],
  );

  prepare(
    'revoke_api_key',
    'Revoke an API key: every system using it stops working at once, and it cannot be undone. A Business ' +
      'Developer may revoke read-only keys only.',
    z.object({ keyPrefix: KEY_PREFIX }).strict(),
    async (args, signal) =>
      keyChange(args.keyPrefix, signal, (key) => ({
        method: 'DELETE',
        body: {},
        summary:
          `Revoke API key "${key.name}" (${args.keyPrefix}…, ${key.scopes.join(' and ')}): every system using it ` +
          'stops working at once. This cannot be undone.',
      })),
    ['listApiKeys'],
  );

  // --- Organization settings (Owner) ------------------------------------------------------------

  prepare(
    'set_refund_policy',
    'Publish a new version of the voucher refund policy (Owner). Fields left out keep their current value.',
    z
      .object({
        allowUnused: z.boolean().optional(),
        allowExpired: z.boolean().optional(),
        allowRedeemed: z.boolean().optional(),
        restockUnused: z.boolean().optional(),
        refundWindowDays: z.number().int().min(1).max(3650).nullable().optional().describe('null: no time limit'),
        reason: z.string().trim().min(1).max(500).describe('Why the policy changes, kept with this version'),
      })
      .strict(),
    async (args, signal) => {
      const current = await core.getRefundPolicy!({ signal });
      const next = {
        allowUnused: args.allowUnused ?? current.allowUnused,
        allowExpired: args.allowExpired ?? current.allowExpired,
        allowRedeemed: args.allowRedeemed ?? current.allowRedeemed,
        restockUnused: args.restockUnused ?? current.restockUnused,
        refundWindowDays: args.refundWindowDays === undefined ? current.refundWindowDays : args.refundWindowDays,
      };
      const changes = (Object.keys(REFUND_FIELDS) as Array<keyof typeof REFUND_FIELDS>)
        .filter((field) => next[field] !== current[field])
        .map((field) => `${REFUND_FIELDS[field]}: ${show(current[field])} → ${show(next[field])}`);
      if (changes.length === 0) throw new WriteInputError('That is already the current refund policy.');
      return {
        method: 'PUT',
        path: core.organizationPath('/refund-policy'),
        body: { ...next, reason: args.reason },
        summary: `Publish refund policy version ${current.version + 1}: ${changes.join('; ')}. Reason: "${args.reason}".`,
      };
    },
    ['getRefundPolicy'],
  );

  prepare(
    'set_voucher_approval_required',
    "Turn the Owner's approval of Business Developers' vouchers on or off (Owner).",
    z.object({ required: z.boolean() }).strict(),
    async (args) => ({
      method: 'PATCH',
      path: core.organizationPath('/settings'),
      body: { voucherApprovalRequired: args.required },
      summary: args.required
        ? "Require an Owner's approval before a Business Developer's voucher goes live."
        : "Stop requiring an Owner's approval: Business Developers can activate vouchers themselves. Vouchers " +
          'already waiting stay waiting.',
    }),
  );

  prepare(
    'update_organization_display',
    "Change the organization's display name or logo (Owner). Legal details change only through a request " +
      'to the System Admin, not here.',
    z
      .object({
        name: z.string().trim().min(2).max(160).optional(),
        logoUrl: z
          .string()
          .url()
          .startsWith('https://')
          .max(2048)
          .nullable()
          .optional()
          .describe('An https URL; null removes the logo'),
      })
      .strict()
      .refine((value) => value.name !== undefined || value.logoUrl !== undefined, 'Change at least one field'),
    async (args, signal) => {
      const organization = await core.getOrganization!({ signal });
      return {
        method: 'PATCH',
        path: core.organizationPath('/profile'),
        body: definedOnly({ name: args.name, logoUrl: args.logoUrl }),
        summary:
          'Change the organization: ' +
          [
            args.name !== undefined ? `name: "${organization.name}" → "${args.name}"` : null,
            args.logoUrl !== undefined ? `logo: ${args.logoUrl ?? 'removed'}` : null,
          ]
            .filter(Boolean)
            .join('; ') +
          '.',
      };
    },
    ['getOrganization'],
  );

  // --- Webhooks: never registering one or rotating its secret, which would return the secret. ----

  const ENDPOINT_ACTIONS = [
    [
      'disable_webhook_endpoint',
      'disable',
      'Stop sending events to a webhook endpoint (Owner).',
      'events stop being sent to it',
    ],
    [
      'enable_webhook_endpoint',
      'enable',
      'Send events to a disabled webhook endpoint again (Owner).',
      'events are sent to it again',
    ],
  ] as const;
  for (const [name, action, description, effect] of ENDPOINT_ACTIONS) {
    prepare(
      name,
      description,
      z.object({ endpointId: z.string().uuid().describe('From list_webhook_endpoints') }).strict(),
      async (args, signal) => {
        const endpoint = (await core.consoleWebhookEndpoints!({ signal })).find((item) => item.id === args.endpointId);
        if (!endpoint) throw new WriteInputError('No webhook endpoint with this id. Use list_webhook_endpoints.');
        return {
          method: 'POST',
          path: core.organizationPath(`/webhooks/endpoints/${encodeURIComponent(args.endpointId)}/${action}`),
          body: {},
          summary: `${action === 'enable' ? 'Enable' : 'Disable'} the webhook endpoint ${withoutQuery(endpoint.url)}: ${effect}.`,
        };
      },
      ['consoleWebhookEndpoints'],
    );
  }

  prepare(
    'send_test_webhook',
    'Send a webhook.test event to one endpoint through the normal signed delivery, to check the receiver ' +
      'works. Nothing else changes.',
    z.object({ endpointId: z.string().uuid().describe('From list_webhook_endpoints') }).strict(),
    async (args, signal) => {
      const endpoint = (await core.consoleWebhookEndpoints!({ signal })).find((item) => item.id === args.endpointId);
      if (!endpoint) throw new WriteInputError('No webhook endpoint with this id. Use list_webhook_endpoints.');
      return {
        method: 'POST',
        path: core.organizationPath(`/webhooks/endpoints/${encodeURIComponent(args.endpointId)}/test`),
        body: {},
        summary: `Send a webhook.test event to ${withoutQuery(endpoint.url)}. Check list_webhook_deliveries for the result.`,
      };
    },
    ['consoleWebhookEndpoints'],
  );

  prepare(
    'replay_webhook_delivery',
    'Send a failed (DEAD_LETTER) webhook delivery again, with the same event id.',
    z.object({ deliveryId: z.string().uuid().describe('From list_webhook_deliveries') }).strict(),
    async (args, signal) => {
      const delivery = (await core.consoleWebhookDeliveries!({ signal })).find((item) => item.id === args.deliveryId);
      if (!delivery) throw new WriteInputError('No recent webhook delivery with this id. Use list_webhook_deliveries.');
      return {
        method: 'POST',
        path: core.organizationPath(`/webhooks/deliveries/${encodeURIComponent(args.deliveryId)}/replay`),
        body: {},
        summary:
          `Send the ${delivery.eventType ?? 'webhook'} event of delivery ${args.deliveryId.slice(0, 8)}… again ` +
          `(now ${delivery.status ?? 'unknown'}).`,
      };
    },
    ['consoleWebhookDeliveries'],
  );

  if (allowed.has('confirm_change')) {
    server.registerTool(
      'confirm_change',
      {
        description:
          'Make a change prepared earlier, after the user clearly agreed to its summary. Never call it on your ' +
          'own initiative or for a change the user did not see. A retry with the same confirmationId returns ' +
          'the same result instead of changing anything twice.',
        inputSchema: z.object({ confirmationId: z.string().min(1).max(100) }).strict(),
        outputSchema: APPLIED,
        annotations: APPLY,
      },
      async (args: { confirmationId: string }, extra: ToolExtra) => {
        try {
          const signal = combineSignal(extra);
          const change = await core.getChange(args.confirmationId, { signal });
          const answer = await core.applyChange(change, { signal });
          return result(
            'confirm_change',
            {
              done: true,
              summary: change.summary,
              voucher: isVoucher(answer) ? voucherDetailOf(answer) : null,
              outcomes: outcomesOf(answer),
            },
            true,
          );
        } catch (error) {
          return writeError('confirm_change', error);
        }
      },
    );
  }
}

/** The submission an Owner decides on; Core refuses it if it changed since (409). */
function pendingApproval(voucher: VoucherDto): string {
  if (voucher.status !== 'PENDING_APPROVAL' || voucher.approval?.status !== 'PENDING' || !voucher.approval.id)
    throw new WriteInputError(`Voucher "${voucher.title}" is ${voucher.status}, not waiting for approval.`);
  return voucher.approval.id;
}

/** Each voucher's result, from a batch import (`items`) or a batch action (`vouchers`). */
function outcomesOf(answer: unknown): Array<{ code: string | null; result: string; reason: string | null }> | null {
  const value = answer as { items?: unknown; vouchers?: unknown } | null;
  if (Array.isArray(value?.items))
    return (value.items as Array<{ code?: string | null; status?: string; error?: { message?: string } }>).map(
      (item) => ({ code: item.code ?? null, result: item.status ?? 'unknown', reason: item.error?.message ?? null }),
    );
  if (Array.isArray(value?.vouchers) && !isVoucher(value))
    return (value.vouchers as Array<{ code?: string; outcome?: string; reason?: string | null }>).map((voucher) => ({
      code: voucher.code ?? null,
      result: voucher.outcome ?? 'unknown',
      reason: voucher.reason ?? null,
    }));
  return null;
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

const REFUND_FIELDS = {
  allowUnused: 'refund unused vouchers',
  allowExpired: 'refund expired vouchers',
  allowRedeemed: 'refund redeemed vouchers',
  restockUnused: 'return refunded unused vouchers to supply',
  refundWindowDays: 'refund window (days after claim)',
} as const;

const show = (value: unknown) =>
  value === null ? 'none' : value === true ? 'on' : value === false ? 'off' : String(value);

/** A URL without its query string, which often carries a token. */
function withoutQuery(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return 'the endpoint';
  }
}

function isVoucher(value: unknown): value is VoucherDto {
  return (
    typeof value === 'object' && value !== null && typeof (value as VoucherDto).id === 'string' && 'status' in value
  );
}

const definedOnly = (value: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));

const FIELD_LABELS: Record<string, string> = {
  code: 'code',
  title: 'title',
  description: 'description',
  pointsCost: 'points cost',
  discountType: 'discount type',
  discountValue: 'discount value',
  totalSupply: 'total supply',
  perMemberLimit: 'limit per member',
  startsAt: 'starts',
  expiresAt: 'claims close',
  validForDays: 'valid for days after issue',
};

/** The fields as the user should read them: every value, so nothing is changed unseen. */
function describeFields(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .filter(([key, value]) => value !== undefined && key in FIELD_LABELS)
    .map(([key, value]) => `${FIELD_LABELS[key]}: ${value === null ? 'none (no limit)' : String(value)}`)
    .join('; ');
}

/** A request the tool itself refuses before asking Core, with a message the model can act on. */
class WriteInputError extends Error {}

/**
 * A bounded, model-safe error for a write. Unlike a read, a refused change needs its reason to be
 * fixed, so Core's own message is passed on for a 400 or 409: Core writes those for the merchant, and
 * they never hold a secret.
 */
function writeError(tool: string, error: unknown) {
  const text = (message: string) => ({ isError: true as const, content: [{ type: 'text' as const, text: message }] });
  if (error instanceof WriteInputError) return text(error.message);
  if (isOctaApiError(error)) {
    console.error(JSON.stringify({ event: 'core_api_error', tool, status: error.statusCode }));
    const reason = coreMessage(error.responseBody);
    switch (error.statusCode) {
      case 400:
      case 409:
      case 422:
        return text(`Core refused this change${reason ? `: ${reason}` : '.'}`);
      case 401:
        return text('The sign-in expired. Ask the user to sign in again from their MCP client.');
      case 403:
        return text(
          `Core refused this change${reason ? `: ${reason}` : ''}. The signed-in role may not do this, or this ` +
            'connection was allowed to read only.',
        );
      case 404:
        return text(
          'Not found in the connected organization: no such item, or the pending change expired. Prepare it again.',
        );
      case 429:
        return text('Rate limited; do not retry this call in this turn.');
      default:
        return text(
          'Core is temporarily unavailable; the change was not confirmed as made. Do not retry in this turn.',
        );
    }
  }
  console.error(JSON.stringify({ event: 'core_request_failed', tool }));
  return text('Core could not complete this change. Check the local server logs.');
}

function coreMessage(body: unknown): string | null {
  const message = (body as { message?: unknown } | null)?.message;
  const value = Array.isArray(message) ? message.join('; ') : message;
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : null;
}
