import type { ExecutionContext } from '@nestjs/common';
import type { CreditAccountEvent } from '@octap/chain';
import type { ChainCallResult } from '../../src/infra/clients/sui/sui.client.js';
import type { operations } from '../../src/infra/db/schema/operations.schema.js';
import type { loyaltyTransactions } from '../../src/infra/db/schema/credits.schema.js';
import type { vouchers } from '../../src/infra/db/schema/rewards.schema.js';
import type { programs } from '../../src/infra/db/schema/programs.schema.js';
import type { ProgramsRepository } from '../../src/infra/db/repositories/programs.repository.js';
import { stub } from './stub.js';

export const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

/** What `SuiClientService` returns: a submitted transaction plus the `eventField` lookup. */
export function fakeChainResult({
  status = 'success',
  errorMessage,
  events = [],
  digest = 'DIGEST1',
}: {
  status?: 'success' | 'failure';
  errorMessage?: string;
  events?: Array<{ type: string; parsedJson: unknown }>;
  digest?: string;
} = {}): ChainCallResult {
  return {
    digest,
    status,
    errorMessage,
    events,
    eventField<T>(eventSuffix: string, field: string) {
      const event = events.find((e) => e.type.endsWith(`::${eventSuffix}`));
      return (event?.parsedJson as Record<string, unknown> | undefined)?.[field] as T | undefined;
    },
  };
}

export function buildOperation(
  overrides: Partial<typeof operations.$inferSelect> = {},
): typeof operations.$inferSelect {
  return {
    id: 'op-1',
    tenantId: 'org-1',
    commandType: 'CREDIT_EARN_CHAIN_SUBMIT',
    idempotencyKey: 'idem-chain-1',
    status: 'PROCESSING',
    payload: { loyaltyTransactionId: 'tx-1', organizationEndUserId: 'user-1', pointsAmount: 10000 },
    payloadHash: null,
    suiTxDigest: null,
    suiTxExpirationEpoch: null,
    errorMessage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as typeof operations.$inferSelect;
}

export function buildLoyaltyTransaction(
  overrides: Partial<typeof loyaltyTransactions.$inferSelect> = {},
): typeof loyaltyTransactions.$inferSelect {
  return {
    id: 'tx-earn-1',
    organizationId: 'org-1',
    organizationEndUserId: 'user-1',
    createdByMembershipId: null,
    blockchainTransactionId: null,
    transactionType: 'EARN',
    pointsAmount: 50,
    idempotencyKey: 'earn-1',
    receiptReference: null,
    status: 'CONFIRMED',
    reversesTransactionId: null,
    metadata: {},
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  } as typeof loyaltyTransactions.$inferSelect;
}

export function buildVoucher(overrides: Partial<typeof vouchers.$inferSelect> = {}): typeof vouchers.$inferSelect {
  return {
    id: 'v-1',
    organizationId: 'org-1',
    code: 'DISCOUNT10',
    title: '10% Off',
    description: 'Get 10% off',
    pointsCost: 50,
    discountType: 'PERCENTAGE',
    discountValue: '10.00',
    totalSupply: 100,
    claimedCount: 0,
    status: 'ACTIVE',
    startsAt: null,
    expiresAt: null,
    metadata: {},
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  } as typeof vouchers.$inferSelect;
}

export function earnedEvent(overrides: Partial<CreditAccountEvent> = {}): CreditAccountEvent {
  return {
    name: 'CreditEarned',
    sender: '0xissuer',
    json: { account_id: '0xacc1', amount: '100', operation_key: b64('idem-earn-1') },
    checkpoint: '500',
    transactionDigest: 'DIGEST-EARN',
    eventIndex: 0,
    ...overrides,
  };
}

export interface FakeHttpRequest {
  headers: Record<string, string | undefined>;
  method: string;
  url: string;
  originalUrl?: string;
  rawBody?: Buffer;
  tenant?: unknown;
}

/** A Nest `ExecutionContext` over a plain request object; `request` is exposed for assertions. */
export function executionContext({
  headers = {},
  method = 'GET',
  url = '/v1/test',
  rawBody = Buffer.from(''),
  handler = () => {},
  klass = class {},
}: {
  headers?: Record<string, string | undefined>;
  method?: string;
  url?: string;
  rawBody?: Buffer;
  handler?: () => void;
  klass?: new () => unknown;
} = {}): ExecutionContext & { request: FakeHttpRequest } {
  const request: FakeHttpRequest = { headers, method, url, rawBody };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => klass,
    request,
  } as unknown as ExecutionContext & { request: FakeHttpRequest };
}

/** A fully provisioned (`ACTIVE`, sharded) `programs` row whose ids all name `organizationId`. */
export function buildProgramRow(
  organizationId: string,
  overrides: Partial<typeof programs.$inferSelect> = {},
): typeof programs.$inferSelect {
  return {
    id: `program-${organizationId}`,
    organizationId,
    status: 'ACTIVE',
    programControlId: `0xprogram-${organizationId}`,
    adminCapId: `0xadmincap-${organizationId}`,
    policyVersionId: `0xpolicy-${organizationId}`,
    issuerCapId: `0xissuercap-${organizationId}`,
    policyVersion: 1,
    earnBps: 100,
    expiryMs: 30 * 24 * 60 * 60 * 1000,
    shardCount: 1,
    totalBudget: 1_000_000,
    operationShardIds: [`0xop0-${organizationId}`],
    budgetShardIds: [`0xbudget0-${organizationId}`],
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  } as typeof programs.$inferSelect;
}

/** The `OctapProgramConfig` that `resolveProgramConfig` derives from `buildProgramRow(organizationId)`. */
export function programConfigFor(organizationId: string) {
  return {
    programControlId: `0xprogram-${organizationId}`,
    policyVersionId: `0xpolicy-${organizationId}`,
    issuerCapId: `0xissuercap-${organizationId}`,
    operationShardIds: [`0xop0-${organizationId}`],
    budgetShardIds: [`0xbudget0-${organizationId}`],
  };
}

/** `ProgramsRepository` double over organizationId -> row (missing key = no row). */
export function programsRepoFor(rows: Record<string, typeof programs.$inferSelect | undefined>): ProgramsRepository {
  return stub<ProgramsRepository>({ findByOrganization: async (organizationId: string) => rows[organizationId] });
}

/** Only `org-1` is provisioned. */
export const PROGRAMS_REPO = programsRepoFor({ 'org-1': buildProgramRow('org-1') });
