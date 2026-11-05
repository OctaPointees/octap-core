import { describe, expect, it } from 'vitest';
import { earnFailureCode } from '#domain/credits/earn-failure.js';

describe('earnFailureCode', () => {
  it('names an exhausted budget only for the budget abort', () => {
    expect(earnFailureCode({ module: 'budget_shard', functionName: 'debit', abortCode: '2' })).toBe('BUDGET_EXHAUSTED');
    expect(earnFailureCode({ module: 'budget_shard', functionName: 'debit', abortCode: '1' })).toBe('REJECTED');
    expect(earnFailureCode({ module: 'credit_account', functionName: 'earn', abortCode: '2' })).toBe('REJECTED');
    expect(earnFailureCode(undefined)).toBe('REJECTED');
  });
});
