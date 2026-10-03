import type { BalanceSnapshot, OperationReference } from '@octap/contracts';
import type { Transport } from './transports/transport.js';
/** Proposed Node merchant client contract. No client factory is implemented. */
export interface OctaPointClientOptions {
  transport: Transport;
  credentials: { apiKey: string };
}
export interface OctaPointClient {
  getBalance(programId: string, memberId: string): Promise<BalanceSnapshot>;
  waitForOperation(operationId: string): Promise<OperationReference>;
}
// Earn/redeem DTOs, retries, deadlines and typed errors await API contract design.
