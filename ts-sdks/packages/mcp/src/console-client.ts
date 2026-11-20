import {
  OctaApiError,
  type CreditBalanceSnapshot,
  type LoyaltyTransactionPage,
  type VoucherOwnershipDto,
} from '@octap/sdk';
import type { CoreClientLike } from './server.js';

/** Core's `GET /v1/console/mcp/token` answer (`McpTokenIntrospection` in `@octap/contracts`). */
export interface McpTokenIntrospection {
  active: true;
  clientId: string;
  scopes: string[];
  userId: string;
  organizationId: string;
  persona: 'BUSINESS_OWNER' | 'BUSINESS_DEVELOPER';
  resource: string;
  expiresAt: number;
}

interface RequestOptions {
  signal?: AbortSignal;
}

/**
 * The tools' Core client for a signed-in user (OCT-293): the same three reads, through the console
 * member routes of the token's own organization, with the user's MCP access token. Core rechecks
 * the token, the membership and the persona on every call, so this client holds no authority itself.
 */
export function consoleCoreClient(apiUrl: string, accessToken: string, organizationId: string): CoreClientLike {
  const base = `${apiUrl.replace(/\/+$/, '')}/v1/console/organizations/${encodeURIComponent(organizationId)}/members`;
  const get = async <T>(path: string, options?: RequestOptions): Promise<T> => {
    const response = await fetch(`${base}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: options?.signal,
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new OctaApiError(response.status, response.statusText, body);
    return body as T;
  };
  const member = (memberId: string) => `/${encodeURIComponent(memberId)}`;

  return {
    getBalance: (async (memberId: string, options?: RequestOptions) => {
      const detail = await get<{ balance: CreditBalanceSnapshot }>(member(memberId), options);
      return detail.balance;
    }) as CoreClientLike['getBalance'],
    listTransactions: async (memberId, options) => {
      const query = new URLSearchParams();
      if (options?.limit !== undefined) query.set('limit', String(options.limit));
      if (options?.cursor) query.set('cursor', options.cursor);
      const suffix = query.size > 0 ? `?${query}` : '';
      return get<LoyaltyTransactionPage>(`${member(memberId)}/transactions${suffix}`, options);
    },
    listMemberVouchers: async (memberId, options) =>
      get<VoucherOwnershipDto[]>(`${member(memberId)}/vouchers`, options),
  };
}

/** Asks Core what an MCP access token is bound to. Null when Core refuses the token. */
export async function introspectToken(
  apiUrl: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<McpTokenIntrospection | null> {
  const response = await fetch(`${apiUrl.replace(/\/+$/, '')}/v1/console/mcp/token`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    signal,
  });
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new Error(`Core token check failed with status ${response.status}`);
  return (await response.json()) as McpTokenIntrospection;
}
