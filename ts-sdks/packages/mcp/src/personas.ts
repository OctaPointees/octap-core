import type { PromptName, ToolName } from './server.js';

/** The organization personas Core puts on an MCP access token. */
export type Persona = 'BUSINESS_OWNER' | 'BUSINESS_DEVELOPER';

/**
 * Which tools each persona sees (OCT-294), in one place so it is easy to review.
 *
 * This map is for relevance, not security. Core is the authority: every tool call goes to the
 * console routes with the user's own token, and Core checks the organization, the read-only rule
 * and the persona again. A wrong entry here can show a tool Core then refuses (403); it can never
 * read more than Core allows.
 *
 * - Business Developer: integration work. The organization, members and what they hold (to debug
 *   what an integration sent), the voucher catalog and batches, the budget, API keys, and webhook
 *   endpoints and deliveries. Every Developer tool reads a route Core opens to both personas.
 * - Business Owner: in Core an Owner can do everything a Developer can, so the Owner set holds every
 *   Developer tool, plus the reads Core keeps for Owners: the refund policy and its history, staff
 *   and invitations.
 */
export const DEVELOPER_TOOLS: readonly ToolName[] = [
  'get_connection',
  'get_organization',
  'find_member',
  'get_member',
  'get_member_balance',
  'list_member_transactions',
  'list_member_vouchers',
  'list_vouchers',
  'get_voucher',
  'list_voucher_batches',
  'get_voucher_batch',
  'get_budget',
  'list_api_keys',
  'list_webhook_endpoints',
  'list_webhook_deliveries',
];

export const OWNER_TOOLS: readonly ToolName[] = [
  ...DEVELOPER_TOOLS,
  'get_refund_policy',
  'get_refund_policy_history',
  'list_staff',
  'list_invitations',
];

export const PERSONA_TOOLS: Readonly<Record<Persona, readonly ToolName[]>> = {
  BUSINESS_OWNER: OWNER_TOOLS,
  BUSINESS_DEVELOPER: DEVELOPER_TOOLS,
};

/**
 * Write tools (OCT-314), offered only to a connection the user allowed to make changes (`mcp:write`).
 * Both personas draft vouchers, edit them, take them back and activate them (Core refuses a Developer
 * where approval is required); a Developer submits a draft to an Owner. Pausing and deciding an
 * approval are an Owner's. As with reads, Core checks the persona again on every write.
 */
export const DEVELOPER_WRITE_TOOLS: readonly ToolName[] = [
  'create_voucher',
  'update_voucher',
  'submit_voucher',
  'withdraw_voucher',
  'activate_voucher',
  'confirm_change',
];

export const OWNER_WRITE_TOOLS: readonly ToolName[] = [
  'create_voucher',
  'update_voucher',
  'withdraw_voucher',
  'activate_voucher',
  'pause_voucher',
  'approve_voucher',
  'reject_voucher',
  'confirm_change',
];

export const PERSONA_WRITE_TOOLS: Readonly<Record<Persona, readonly ToolName[]>> = {
  BUSINESS_OWNER: OWNER_WRITE_TOOLS,
  BUSINESS_DEVELOPER: DEVELOPER_WRITE_TOOLS,
};

/**
 * Which prompts each persona sees. A prompt is also offered only when its tools are. The approval,
 * budget and access reviews are an Owner's job.
 */
export const DEVELOPER_PROMPTS: readonly PromptName[] = [
  'find_customer',
  'check_member_transactions',
  'summarize_member',
  'review_api_keys',
  'check_webhooks',
];

export const OWNER_PROMPTS: readonly PromptName[] = [
  ...DEVELOPER_PROMPTS,
  'review_pending_vouchers',
  'check_budget',
  'review_console_access',
];

export const PERSONA_PROMPTS: Readonly<Record<Persona, readonly PromptName[]>> = {
  BUSINESS_OWNER: OWNER_PROMPTS,
  BUSINESS_DEVELOPER: DEVELOPER_PROMPTS,
};

const PERSONA_LABEL: Readonly<Record<Persona, string>> = {
  BUSINESS_OWNER: 'Business Owner',
  BUSINESS_DEVELOPER: 'Business Developer',
};

function isPersona(value: string): value is Persona {
  return Object.hasOwn(PERSONA_TOOLS, value);
}

/**
 * The persona's tools, with its write tools when the connection may make changes. An unknown persona
 * gets only `get_connection`, never more.
 */
export function toolsForPersona(persona: string, canWrite = false): readonly ToolName[] {
  if (!isPersona(persona)) return ['get_connection'];
  return canWrite ? [...PERSONA_TOOLS[persona], ...PERSONA_WRITE_TOOLS[persona]] : PERSONA_TOOLS[persona];
}

/** The persona's prompts. An unknown persona gets none. */
export function promptsForPersona(persona: string): readonly PromptName[] {
  return isPersona(persona) ? PERSONA_PROMPTS[persona] : [];
}

/** Server instructions for a session. The persona comes from Core's token check, never from the model. */
export function instructionsForPersona(persona: string, canWrite = false): string {
  const role = isPersona(persona) ? PERSONA_LABEL[persona] : 'an unrecognized role';
  const access = canWrite
    ? 'Every tool works on that organization only. Changes take two steps: a tool such as create_voucher ' +
      'only prepares a change and returns a summary; show that summary to the user word for word, and call ' +
      'confirm_change only after they clearly agree. Never confirm a change on your own initiative.'
    : 'Every tool reads that organization only, and every tool is read-only.';
  return (
    `This session is signed in to one OctaP organization as ${role}. ${access} Call get_connection to ` +
    'see which organization it is. To look a customer up by name, email, phone or POS id, start with ' +
    'find_member. Answer from tool results only; if a tool is refused or fails, say so instead of guessing.'
  );
}
