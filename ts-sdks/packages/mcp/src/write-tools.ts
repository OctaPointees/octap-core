import type { McpServer } from '@modelcontextprotocol/server';
import type { VoucherDto } from '@octap/sdk';
import * as z from 'zod/v4';
import type { PreparedChange } from './console-client.js';
import { VOUCHER_DETAIL, voucherDetailOf } from './console-tools.js';
import { combineSignal, isOctaApiError, result, type ToolExtra } from './tool-kit.js';

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
  /** The console path of the organization's vouchers, or of one voucher. */
  voucherPath(voucherId?: string): string;
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
  'confirm_change',
];

const WRITE_METHODS: Array<keyof ConsoleWrites> = [
  'voucherPath',
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
  voucher: VOUCHER_DETAIL.nullable().describe('The voucher as it is now'),
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
export function registerWriteTools(server: McpServer, core: ConsoleWrites, allowed: ReadonlySet<string>) {
  const prepare = <Args>(
    name: WriteToolName,
    description: string,
    input: z.ZodType<Args>,
    build: (args: Args, signal: AbortSignal) => Promise<ChangeInput>,
  ) => {
    if (!allowed.has(name)) return;
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
    return { ...change, path: `${core.voucherPath(voucherId)}${suffix ?? ''}` };
  };

  prepare(
    'create_voucher',
    'Create a new voucher as a DRAFT: customers cannot see or claim it until it is activated (or, for a ' +
      'Business Developer, submitted and approved by an Owner).',
    CREATE_INPUT,
    async (args) => ({
      method: 'POST',
      path: core.voucherPath(),
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
            { done: true, summary: change.summary, voucher: isVoucher(answer) ? voucherDetailOf(answer) : null },
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
          'No such voucher or pending change in the connected organization. It may have expired; prepare it again.',
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
