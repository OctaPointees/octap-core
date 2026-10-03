/** Draft boundary types from the knowledge base; wire schemas remain to be designed. */
export type Points = string; // Decimal u64 string; validation is not implemented.
export interface ActorContext {
  tenantId: string;
  actorId: string;
  scopes: readonly string[];
}
export interface OperationReference {
  operation_id: string;
}
export interface BalanceSnapshot {
  confirmed_balance: Points;
  pending_earn: Points;
  pending_redemption: Points;
  as_of_checkpoint: string;
  observed_at: string;
  stale: boolean;
}
