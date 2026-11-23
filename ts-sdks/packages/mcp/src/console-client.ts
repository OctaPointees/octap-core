import {
  OctaApiError,
  type CreditBalanceSnapshot,
  type LoyaltyTransactionPage,
  type VoucherOwnershipDto,
} from '@octap/sdk';
import type {
  ApiKeyView,
  ConnectionInfo,
  ConsoleReads,
  CoreClientLike,
  InvitationView,
  MemberDetailView,
  MemberPageView,
  OrganizationView,
  RefundPolicyVersionView,
  RefundPolicyView,
  StaffView,
  WebhookDeliveryView,
  WebhookEndpointView,
} from './server.js';
import type { IssuanceBudgetDto, VoucherBatchDetailDto, VoucherBatchDto, VoucherDto } from '@octap/sdk';

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

/** `GET /v1/console/me` with an MCP token: the identity lists only the token's organization. */
interface ConsoleMe {
  user: { fullName: string };
  organizations: Array<{ organizationId: string; name: string; slug: string; persona: string }>;
  expiresAt: string;
}

/**
 * The tools' Core client for a signed-in user (OCT-293, OCT-294): the member reads plus the console
 * reads, through the console routes of the token's own organization, with the user's MCP access
 * token. Core rechecks the token, the membership and the persona on every call, so this client
 * holds no authority itself.
 */
export function consoleCoreClient(
  apiUrl: string,
  accessToken: string,
  organizationId: string,
): CoreClientLike & ConsoleReads {
  const root = apiUrl.replace(/\/+$/, '');
  const organization = `/v1/console/organizations/${encodeURIComponent(organizationId)}`;
  const get = async <T>(path: string, options?: RequestOptions): Promise<T> => {
    const response = await fetch(`${root}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: options?.signal,
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new OctaApiError(response.status, response.statusText, body);
    return body as T;
  };
  const member = (memberId: string) => `${organization}/members/${encodeURIComponent(memberId)}`;
  const withQuery = (path: string, query: Record<string, string | number | boolean | undefined>) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
    return params.size > 0 ? `${path}?${params}` : path;
  };

  return {
    getConnection: async (options) => {
      const me = await get<ConsoleMe>('/v1/console/me', options);
      const bound = me.organizations.find((candidate) => candidate.organizationId === organizationId);
      // Core lists only the token's organization; anything else means the token changed under us.
      if (!bound) throw new OctaApiError(401, 'Unauthorized', null);
      const connection: ConnectionInfo = {
        organization: { id: bound.organizationId, name: bound.name, slug: bound.slug },
        persona: bound.persona,
        signedInAs: me.user.fullName,
        expiresAt: me.expiresAt,
      };
      return connection;
    },
    getRefundPolicy: async (options) => get<RefundPolicyView>(`${organization}/refund-policy`, options),
    listApiKeys: async (options) => get<ApiKeyView[]>(`${organization}/api-credentials`, options),
    getOrganization: async (options) => get<OrganizationView>(organization, options),
    findMembers: async (search, options) =>
      get<MemberPageView>(
        withQuery(`${organization}/members`, {
          q: search.q,
          externalMemberId: search.externalMemberId,
          status: search.status,
          limit: search.limit,
          cursor: search.cursor,
        }),
        options,
      ),
    getMember: async (memberId, options) => get<MemberDetailView>(member(memberId), options),
    consoleVouchers: async (options) => get<VoucherDto[]>(`${organization}/vouchers`, options),
    consoleVoucher: async (voucherId, options) =>
      get<VoucherDto>(`${organization}/vouchers/${encodeURIComponent(voucherId)}`, options),
    consoleVoucherBatches: async (includeArchived, options) =>
      get<VoucherBatchDto[]>(
        withQuery(`${organization}/voucher-batches`, { includeArchived: includeArchived || undefined }),
        options,
      ),
    consoleVoucherBatch: async (batchId, options) =>
      get<VoucherBatchDetailDto>(`${organization}/voucher-batches/${encodeURIComponent(batchId)}`, options),
    getBudget: async (options) => get<IssuanceBudgetDto>(`${organization}/budget`, options),
    consoleWebhookEndpoints: async (options) =>
      get<WebhookEndpointView[]>(`${organization}/webhooks/endpoints`, options),
    consoleWebhookDeliveries: async (options) =>
      get<WebhookDeliveryView[]>(`${organization}/webhooks/deliveries`, options),
    getRefundPolicyHistory: async (page, options) =>
      get<RefundPolicyVersionView[]>(
        withQuery(`${organization}/refund-policy/history`, { limit: page.limit, beforeVersion: page.beforeVersion }),
        options,
      ),
    listStaff: async (options) => get<StaffView[]>(`${organization}/staff`, options),
    listInvitations: async (options) => get<InvitationView[]>(`${organization}/invitations`, options),
    getBalance: (async (memberId: string, options?: RequestOptions) => {
      const detail = await get<{ balance: CreditBalanceSnapshot }>(member(memberId), options);
      return detail.balance;
    }) as CoreClientLike['getBalance'],
    listTransactions: async (memberId, options) => {
      return get<LoyaltyTransactionPage>(
        withQuery(`${member(memberId)}/transactions`, { limit: options?.limit, cursor: options?.cursor || undefined }),
        options,
      );
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
