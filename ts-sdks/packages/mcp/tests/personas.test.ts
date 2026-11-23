import { describe, expect, it } from 'vitest';
import {
  DEVELOPER_PROMPTS,
  DEVELOPER_TOOLS,
  OWNER_PROMPTS,
  OWNER_TOOLS,
  instructionsForPersona,
  promptsForPersona,
  toolsForPersona,
} from '../src/personas.js';
import { ALL_TOOLS } from '../src/server.js';

describe('persona tool map (OCT-294)', () => {
  it('gives an Owner every Developer tool and prompt, as Core gives an Owner every Developer permission', () => {
    for (const tool of DEVELOPER_TOOLS) expect(OWNER_TOOLS).toContain(tool);
    for (const prompt of DEVELOPER_PROMPTS) expect(OWNER_PROMPTS).toContain(prompt);
    expect([...OWNER_TOOLS].sort()).toEqual([...ALL_TOOLS].sort());
  });

  it('keeps the Owner-only reads away from a Developer', () => {
    const developer = toolsForPersona('BUSINESS_DEVELOPER');
    for (const tool of [
      'get_refund_policy',
      'get_refund_policy_history',
      'list_webhook_endpoints',
      'list_webhook_deliveries',
      'list_staff',
      'list_invitations',
    ] as const) {
      expect(developer).not.toContain(tool);
    }
    expect(promptsForPersona('BUSINESS_DEVELOPER')).not.toContain('review_pending_vouchers');
  });

  it('gives an unknown persona nothing but get_connection, and no prompts', () => {
    expect(toolsForPersona('SYSTEM_ADMIN')).toEqual(['get_connection']);
    expect(toolsForPersona('__proto__')).toEqual(['get_connection']);
    expect(promptsForPersona('__proto__')).toEqual([]);
    expect(instructionsForPersona('SYSTEM_ADMIN')).toContain('an unrecognized role');
  });
});
