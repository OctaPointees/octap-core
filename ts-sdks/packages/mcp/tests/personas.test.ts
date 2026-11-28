import { describe, expect, it } from 'vitest';
import {
  DEVELOPER_PROMPTS,
  DEVELOPER_TOOLS,
  OWNER_PROMPTS,
  OWNER_TOOLS,
  DEVELOPER_WRITE_TOOLS,
  OWNER_WRITE_TOOLS,
  instructionsForPersona,
  promptsForPersona,
  toolsForPersona,
} from '../src/personas.js';
import { ALL_TOOLS, WRITE_TOOLS } from '../src/server.js';

describe('persona tool map (OCT-294)', () => {
  it('gives an Owner every Developer tool and prompt, as Core gives an Owner every Developer permission', () => {
    for (const tool of DEVELOPER_TOOLS) expect(OWNER_TOOLS).toContain(tool);
    for (const prompt of DEVELOPER_PROMPTS) expect(OWNER_PROMPTS).toContain(prompt);
    expect([...OWNER_TOOLS].sort()).toEqual([...ALL_TOOLS].sort());
  });

  it('keeps the Owner-only reads away from a Developer', () => {
    const developer = toolsForPersona('BUSINESS_DEVELOPER');
    for (const tool of ['get_refund_policy', 'get_refund_policy_history', 'list_staff', 'list_invitations'] as const) {
      expect(developer).not.toContain(tool);
    }
    expect(promptsForPersona('BUSINESS_DEVELOPER')).not.toContain('review_pending_vouchers');
  });

  it('gives a Developer the webhook reads, as Core opens them to both personas', () => {
    // Core: GET …/webhooks/endpoints and …/deliveries are for an Owner or Business Developer.
    expect(toolsForPersona('BUSINESS_DEVELOPER')).toEqual(
      expect.arrayContaining(['list_webhook_endpoints', 'list_webhook_deliveries']),
    );
    expect(promptsForPersona('BUSINESS_DEVELOPER')).toContain('check_webhooks');
  });

  it('gives a Developer the member reads Core opens to both personas, including what a member holds', () => {
    // Core: GET …/members/:id/vouchers is for an Owner or Business Developer (members.service.ts).
    expect(toolsForPersona('BUSINESS_DEVELOPER')).toContain('list_member_vouchers');
    expect(promptsForPersona('BUSINESS_DEVELOPER')).toContain('summarize_member');
  });

  it('gives an unknown persona nothing but get_connection, and no prompts', () => {
    expect(toolsForPersona('SYSTEM_ADMIN')).toEqual(['get_connection']);
    expect(toolsForPersona('__proto__')).toEqual(['get_connection']);
    expect(promptsForPersona('__proto__')).toEqual([]);
    expect(instructionsForPersona('SYSTEM_ADMIN')).toContain('an unrecognized role');
  });

  it('offers write tools only to a connection allowed to make changes (OCT-314)', () => {
    for (const persona of ['BUSINESS_OWNER', 'BUSINESS_DEVELOPER']) {
      for (const tool of WRITE_TOOLS) expect(toolsForPersona(persona)).not.toContain(tool);
      expect(toolsForPersona(persona, true)).toContain('confirm_change');
      expect(instructionsForPersona(persona)).toContain('read-only');
      expect(instructionsForPersona(persona, true)).toContain('confirm_change only after they clearly agree');
    }
    expect(toolsForPersona('SYSTEM_ADMIN', true)).toEqual(['get_connection']);
  });

  it('keeps Owner decisions away from a Developer, and submitting away from an Owner', () => {
    // Core: approve, reject and pause are Owner-only; an Owner activates instead of submitting (409).
    for (const tool of ['approve_voucher', 'reject_voucher', 'pause_voucher'] as const) {
      expect(OWNER_WRITE_TOOLS).toContain(tool);
      expect(DEVELOPER_WRITE_TOOLS).not.toContain(tool);
    }
    expect(DEVELOPER_WRITE_TOOLS).toContain('submit_voucher');
    expect(OWNER_WRITE_TOOLS).not.toContain('submit_voucher');
    expect([...new Set([...OWNER_WRITE_TOOLS, ...DEVELOPER_WRITE_TOOLS])].sort()).toEqual([...WRITE_TOOLS].sort());
  });
});
