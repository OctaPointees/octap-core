import { describe, expect, it } from 'vitest';
import { DEVELOPER_TOOLS, OWNER_TOOLS, instructionsForPersona, toolsForPersona } from '../src/personas.js';
import { ALL_TOOLS } from '../src/server.js';

describe('persona tool map (OCT-294)', () => {
  it('gives an Owner every Developer tool, as Core gives an Owner every Developer permission', () => {
    for (const tool of DEVELOPER_TOOLS) expect(OWNER_TOOLS).toContain(tool);
    expect([...OWNER_TOOLS].sort()).toEqual([...ALL_TOOLS].sort());
  });

  it('keeps the Owner-only reads away from a Developer', () => {
    expect(toolsForPersona('BUSINESS_DEVELOPER')).not.toContain('get_refund_policy');
  });

  it('gives an unknown persona nothing but get_connection', () => {
    expect(toolsForPersona('SYSTEM_ADMIN')).toEqual(['get_connection']);
    expect(toolsForPersona('__proto__')).toEqual(['get_connection']);
    expect(instructionsForPersona('SYSTEM_ADMIN')).toContain('an unrecognized role');
  });
});
