import { describe, expect, it } from 'vitest';
import {
  IdentityInputError,
  applyIdentityChange,
  identityProblem,
  parseIdentityChange,
  type IdentityState,
} from '#infra/db/organization-identity.rules.js';

const household: IdentityState = {
  organizationType: 'INDIVIDUAL_HOUSEHOLD',
  legalName: null,
  taxId: null,
  representativeName: 'Nguyen Van A',
};
const company: IdentityState = {
  organizationType: 'COMPANY',
  legalName: 'Cong Ty ABC',
  taxId: '0123456789',
  representativeName: null,
};

describe('parseIdentityChange', () => {
  it('keeps only the legal fields present, trimmed', () => {
    expect(parseIdentityChange({ legalName: '  Cong Ty ABC ', other: 'ignored' })).toEqual({
      legalName: 'Cong Ty ABC',
    });
    expect(parseIdentityChange({})).toEqual({});
  });
  it('rejects malformed values', () => {
    for (const input of [
      { legalName: 5 },
      { taxId: 'x'.repeat(161) },
      { nationalId: '12345' },
      { nationalId: 123456789012 },
      { organizationType: 'ADMIN' },
    ])
      expect(() => parseIdentityChange(input)).toThrow(IdentityInputError);
  });
});

describe('identityProblem', () => {
  it('accepts valid household and company details', () => {
    expect(identityProblem(household, true)).toBeUndefined();
    expect(identityProblem(company, false)).toBeUndefined();
  });
  it('requires company registration details and refuses a company CCCD', () => {
    expect(identityProblem({ ...company, taxId: 'bad format!' }, false)).toMatch(/tax number/);
    expect(identityProblem({ ...company, legalName: ' ' }, false)).toMatch(/legal name/);
    expect(identityProblem(company, true)).toMatch(/CCCD/);
  });
  it('requires a household representative', () => {
    expect(identityProblem({ ...household, representativeName: 'A' }, false)).toMatch(/representative/);
  });
  it('refuses a CCCD before the organization type is chosen', () => {
    expect(identityProblem({ ...household, organizationType: null }, true)).toMatch(/type/);
    expect(identityProblem({ ...household, organizationType: null }, false)).toBeUndefined();
  });
});

describe('applyIdentityChange', () => {
  it('overrides only the fields the change sets', () => {
    expect(applyIdentityChange(company, { legalName: 'Cong Ty XYZ' })).toEqual({
      ...company,
      legalName: 'Cong Ty XYZ',
    });
  });
});
