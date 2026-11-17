import type { OrganizationType } from '@octap/contracts';

/**
 * The legal details an organization is registered with, and the rules they follow. Used when an
 * organization applies, when an `UPDATE_IDENTITY` change request is proposed, and again when it is
 * approved. These fields never change through the profile endpoint.
 */
export const IDENTITY_FIELDS = ['legalName', 'taxId', 'representativeName', 'nationalId', 'organizationType'] as const;
export const ORGANIZATION_TYPES: readonly OrganizationType[] = ['INDIVIDUAL_HOUSEHOLD', 'COMPANY'];
export const TAX_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{1,30}[A-Za-z0-9]$/;
export const NATIONAL_ID_PATTERN = /^\d{12}$/;

/** A text field set to `null` is cleared: blank input is stored as null, never as `""`. */
export interface IdentityChange {
  legalName?: string | null;
  taxId?: string | null;
  representativeName?: string | null;
  nationalId?: string;
  organizationType?: OrganizationType;
}

/** The stored legal details an identity rule is checked against. */
export interface IdentityState {
  organizationType: OrganizationType | null;
  legalName: string | null;
  taxId: string | null;
  representativeName: string | null;
}

/** A request's legal fields are malformed. The message says which one and is safe to show. */
export class IdentityInputError extends Error {}

/**
 * Reads the legal fields present in `input`: text trimmed and at most 160 characters (blank becomes
 * null, so a cleared field is stored as null like one never set), a 12-digit CCCD, a known
 * organization type. Absent fields stay absent. Throws `IdentityInputError`.
 */
export function parseIdentityChange(input: Record<string, unknown>): IdentityChange {
  const change: IdentityChange = {};
  for (const key of ['legalName', 'taxId', 'representativeName'] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length > 160) throw new IdentityInputError(`Invalid ${key}`);
    const text = value.trim();
    change[key] = text === '' ? null : text;
  }
  const nationalId = input.nationalId;
  if (nationalId !== undefined) {
    if (typeof nationalId !== 'string' || !NATIONAL_ID_PATTERN.test(nationalId))
      throw new IdentityInputError('CCCD must contain exactly 12 digits');
    change.nationalId = nationalId;
  }
  const type = input.organizationType;
  if (type !== undefined) {
    if (!ORGANIZATION_TYPES.includes(type as OrganizationType))
      throw new IdentityInputError('Choose Individual / Household business or Company');
    change.organizationType = type as OrganizationType;
  }
  return change;
}

/**
 * The first rule the details that would be stored break, or undefined when they are valid: a
 * company needs a legal name and a registration / tax number and has no CCCD; an individual or
 * household business needs its representative's name.
 */
export function identityProblem(state: IdentityState, hasNewNationalId: boolean): string | undefined {
  if (state.organizationType === 'COMPANY') {
    if (hasNewNationalId) return 'CCCD belongs to the Individual / Household business setup';
    if (!state.legalName || state.legalName.trim().length < 2 || !TAX_ID_PATTERN.test(state.taxId ?? ''))
      return 'A company legal name and business registration / tax number are required';
  }
  if (state.organizationType === 'INDIVIDUAL_HOUSEHOLD' && (state.representativeName ?? '').trim().length < 2)
    return 'A representative full name is required';
  if (state.organizationType === null && hasNewNationalId) return 'Choose the organization type before adding a CCCD';
  return undefined;
}

/** `state` with `change` applied, as it would be stored. */
export function applyIdentityChange(state: IdentityState, change: IdentityChange): IdentityState {
  return {
    organizationType: change.organizationType ?? state.organizationType,
    legalName: change.legalName !== undefined ? change.legalName : state.legalName,
    taxId: change.taxId !== undefined ? change.taxId : state.taxId,
    representativeName: change.representativeName !== undefined ? change.representativeName : state.representativeName,
  };
}
