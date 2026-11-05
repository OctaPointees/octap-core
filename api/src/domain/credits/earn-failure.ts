import type { ChainMoveAbort } from '@octap/chain';
import type { EarnFailureCode } from '@octap/contracts';

/** `budget_shard::EBudgetExceeded`, matched on the structured abort rather than its message. */
export function earnFailureCode(abort?: ChainMoveAbort): EarnFailureCode {
  return abort?.module === 'budget_shard' && abort.abortCode === '2' ? 'BUDGET_EXHAUSTED' : 'REJECTED';
}
