import type { ToolName } from './server.js';

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
 * - Business Developer: integration work. API keys, and read-only member lookups to debug what an
 *   integration sent.
 * - Business Owner: in Core an Owner can do everything a Developer can, so the Owner set holds every
 *   Developer tool, plus the member's vouchers and the refund policy (Owner-only in Core).
 */
export const DEVELOPER_TOOLS: readonly ToolName[] = [
  'get_connection',
  'get_member_balance',
  'list_member_transactions',
  'list_api_keys',
];

export const OWNER_TOOLS: readonly ToolName[] = [...DEVELOPER_TOOLS, 'list_member_vouchers', 'get_refund_policy'];

export const PERSONA_TOOLS: Readonly<Record<Persona, readonly ToolName[]>> = {
  BUSINESS_OWNER: OWNER_TOOLS,
  BUSINESS_DEVELOPER: DEVELOPER_TOOLS,
};

const PERSONA_LABEL: Readonly<Record<Persona, string>> = {
  BUSINESS_OWNER: 'Business Owner',
  BUSINESS_DEVELOPER: 'Business Developer',
};

function isPersona(value: string): value is Persona {
  return Object.hasOwn(PERSONA_TOOLS, value);
}

/** The persona's tools. An unknown persona gets only `get_connection`, never more. */
export function toolsForPersona(persona: string): readonly ToolName[] {
  return isPersona(persona) ? PERSONA_TOOLS[persona] : ['get_connection'];
}

/** Server instructions for a session. The persona comes from Core's token check, never from the model. */
export function instructionsForPersona(persona: string): string {
  const role = isPersona(persona) ? PERSONA_LABEL[persona] : 'an unrecognized role';
  return (
    `This session is signed in to one OctaP organization as ${role}. Every tool reads that ` +
    'organization only, and every tool is read-only. Call get_connection to see which organization ' +
    'it is. Answer from tool results only; if a tool is refused or fails, say so instead of guessing.'
  );
}
