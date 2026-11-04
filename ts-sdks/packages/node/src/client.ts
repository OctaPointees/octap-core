import type {
  BalanceSnapshot,
  OperationReference,
  EarnPointsRequest,
  EarnPointsResponse,
  RedeemPointsRequest,
  RedeemPointsResponse,
  CreditBalanceSnapshot,
  LoyaltyTransactionDto,
  CreateVoucherRequest,
  UpdateVoucherRequest,
  VoucherDto,
  ClaimVoucherRequest,
  ClaimVoucherResponse,
  FinalizePosRedemptionRequest,
  FinalizePosRedemptionResponse,
  RedeemVoucherRequest,
  RedeemVoucherResponse,
  VoucherOwnershipDto,
  SetVoucherRefundPolicyRequest,
  ListVoucherRefundPolicyHistoryRequest,
  VoucherRefundPolicyDto,
  VerifyCustomerResponse,
} from '@octap/contracts';
import type { Transport } from './transports/transport.js';
import { OctaApiError, OctaSdkError } from './errors/index.js';

export interface RequestOptions {
  organizationId?: string;
  signal?: AbortSignal;
}

export interface OctaPointClientOptions {
  baseUrl?: string;
  transport?: Transport;
  credentials?: {
    apiKey?: string;
  };
  organizationId?: string;
  fetchFn?: typeof fetch;
}

export class OctaPointClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly defaultOrganizationId?: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: OctaPointClientOptions = {}) {
    let resolvedBaseUrl = options.baseUrl;
    if (!resolvedBaseUrl && options.transport && options.transport.kind === 'rest') {
      resolvedBaseUrl = options.transport.baseUrl;
    }
    this.baseUrl = (resolvedBaseUrl ?? 'http://localhost:3000').replace(/\/+$/, '');
    this.apiKey = options.credentials?.apiKey;
    this.defaultOrganizationId = options.organizationId;

    if (options.fetchFn) {
      this.fetchFn = options.fetchFn;
    } else if (options.transport && options.transport.kind === 'rest' && options.transport.fetchFn) {
      this.fetchFn = options.transport.fetchFn;
    } else if (typeof fetch !== 'undefined') {
      this.fetchFn = fetch;
    } else {
      throw new OctaSdkError('Global fetch is not available in this runtime environment.');
    }
  }

  private async request<T>(
    path: string,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'GET',
    body?: unknown,
    options?: RequestOptions,
    queryParams?: Record<string, string | number | undefined>,
  ): Promise<T> {
    let url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    if (queryParams) {
      const searchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(queryParams)) {
        if (value !== undefined) {
          searchParams.append(key, String(value));
        }
      }
      const qs = searchParams.toString();
      if (qs) {
        url += `${url.includes('?') ? '&' : '?'}${qs}`;
      }
    }

    const headers: Record<string, string> = {
      accept: 'application/json',
    };

    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    if (this.apiKey) {
      headers['authorization'] = `Bearer ${this.apiKey}`;
    }

    const orgId = options?.organizationId ?? this.defaultOrganizationId;
    if (orgId) {
      headers['x-organization-id'] = orgId;
    }

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: options?.signal,
      });
    } catch (err: unknown) {
      throw new OctaSdkError(`Network request failed for ${method} ${url}: ${(err as Error)?.message ?? String(err)}`);
    }

    let responseData: unknown = null;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      try {
        responseData = await response.json();
      } catch {
        responseData = null;
      }
    } else {
      responseData = await response.text();
    }

    if (!response.ok) {
      throw new OctaApiError(response.status, response.statusText, responseData);
    }

    return responseData as T;
  }

  // ==========================================
  // IDENTITY API
  // ==========================================

  /**
   * Checks the id_token your frontend got from the browser SDK's `getIdToken()`, like Firebase Admin
   * `verifyIdToken`. Writes nothing. `memberId` is null until the customer enrolls in your
   * organization, and `endUserId` is null if they have never signed in to OctaP.
   */
  async verifyCustomer(idToken: string, options?: RequestOptions): Promise<VerifyCustomerResponse> {
    return this.request<VerifyCustomerResponse>('/v1/identity/verify', 'POST', { idToken }, options);
  }

  // ==========================================
  // POINTS & CREDITS API
  // ==========================================

  /**
   * Earn loyalty points for an organization member.
   */
  async earnPoints(request: EarnPointsRequest, options?: RequestOptions): Promise<EarnPointsResponse> {
    return this.request<EarnPointsResponse>('/v1/credits/earn', 'POST', request, options);
  }

  /**
   * Redeem loyalty points for an organization member.
   */
  async redeemPoints(request: RedeemPointsRequest, options?: RequestOptions): Promise<RedeemPointsResponse> {
    return this.request<RedeemPointsResponse>('/v1/credits/redeem', 'POST', request, options);
  }

  /**
   * Get the credit balance snapshot for a member.
   */
  async getBalance(memberId: string): Promise<CreditBalanceSnapshot>;
  async getBalance(programId: string, memberId: string): Promise<BalanceSnapshot>;
  async getBalance(arg1: string, arg2?: string): Promise<CreditBalanceSnapshot | BalanceSnapshot> {
    if (arg2 !== undefined) {
      const memberId = arg2;
      const snapshot = await this.request<CreditBalanceSnapshot>(`/v1/credits/members/${memberId}/balance`, 'GET');
      return {
        confirmed_balance: String(snapshot.confirmedBalance),
        pending_earn: String(snapshot.pendingEarn),
        pending_redemption: String(snapshot.pendingRedemption),
        as_of_checkpoint: snapshot.asOfCheckpoint ?? '0',
        observed_at: snapshot.observedAt,
        stale: snapshot.stale,
      };
    }

    const memberId = arg1;
    return this.request<CreditBalanceSnapshot>(`/v1/credits/members/${memberId}/balance`, 'GET');
  }

  /**
   * List loyalty transactions for a member.
   */
  async listTransactions(
    memberId: string,
    options?: RequestOptions & { limit?: number },
  ): Promise<LoyaltyTransactionDto[]> {
    return this.request<LoyaltyTransactionDto[]>(
      `/v1/credits/members/${memberId}/transactions`,
      'GET',
      undefined,
      options,
      { limit: options?.limit },
    );
  }

  // ==========================================
  // REWARDS & VOUCHERS API
  // ==========================================

  /** Current terms for future voucher claims. */
  async getVoucherRefundPolicy(options?: RequestOptions): Promise<VoucherRefundPolicyDto> {
    return this.request('/v1/rewards/refund-policy', 'GET', undefined, options);
  }

  /** Publishes immutable terms for future claims; requires an admin-scoped credential. */
  async setVoucherRefundPolicy(
    request: SetVoucherRefundPolicyRequest,
    options?: RequestOptions,
  ): Promise<VoucherRefundPolicyDto> {
    return this.request('/v1/rewards/refund-policy', 'PUT', request, options);
  }

  /** Lists immutable policy versions, newest first; requires an admin-scoped credential. */
  async listVoucherRefundPolicyHistory(
    query: ListVoucherRefundPolicyHistoryRequest = {},
    options?: RequestOptions,
  ): Promise<VoucherRefundPolicyDto[]> {
    return this.request('/v1/rewards/refund-policy/history', 'GET', undefined, options, {
      limit: query.limit,
      beforeVersion: query.beforeVersion,
    });
  }

  /** Create a new voucher definition. */
  async createVoucher(request: CreateVoucherRequest, options?: RequestOptions): Promise<VoucherDto> {
    return this.request<VoucherDto>('/v1/rewards/vouchers', 'POST', request, options);
  }

  /** Edit a reward or set its status to DRAFT, ACTIVE or PAUSED. */
  async updateVoucher(voucherId: string, request: UpdateVoucherRequest, options?: RequestOptions): Promise<VoucherDto> {
    return this.request<VoucherDto>(`/v1/rewards/vouchers/${voucherId}`, 'PATCH', request, options);
  }

  /**
   * List all vouchers for the organization.
   */
  async listVouchers(options?: RequestOptions): Promise<VoucherDto[]> {
    return this.request<VoucherDto[]>('/v1/rewards/vouchers', 'GET', undefined, options);
  }

  /**
   * Get a specific voucher by its ID.
   */
  async getVoucher(voucherId: string, options?: RequestOptions): Promise<VoucherDto> {
    return this.request<VoucherDto>(`/v1/rewards/vouchers/${voucherId}`, 'GET', undefined, options);
  }

  /**
   * Reserve a voucher; paid claims return customer-signable bytes and remain RESERVED until chain confirmation.
   */
  async claimVoucher(
    voucherId: string,
    request: ClaimVoucherRequest,
    options?: RequestOptions,
  ): Promise<ClaimVoucherResponse> {
    return this.request<ClaimVoucherResponse>(`/v1/rewards/vouchers/${voucherId}/claim`, 'POST', request, options);
  }

  /** Read persisted claim state after finalize or asynchronous chain recovery. */
  async getVoucherClaim(ownershipId: string, options?: RequestOptions): Promise<ClaimVoucherResponse> {
    return this.request<ClaimVoucherResponse>(`/v1/rewards/claims/${ownershipId}`, 'GET', undefined, options);
  }

  /** The customer signs returned transactionBytes with their zkLogin session; no merchant key is needed by finalize. */
  async finalizeVoucherClaim(
    request: FinalizePosRedemptionRequest,
    options?: RequestOptions,
  ): Promise<FinalizePosRedemptionResponse> {
    return this.request<FinalizePosRedemptionResponse>('/v1/credits/redeem/finalize', 'POST', request, options);
  }

  /**
   * Redeem a claimed voucher by its serial code.
   */
  async redeemVoucher(request: RedeemVoucherRequest, options?: RequestOptions): Promise<RedeemVoucherResponse> {
    return this.request<RedeemVoucherResponse>('/v1/rewards/vouchers/redeem', 'POST', request, options);
  }

  /**
   * List all vouchers claimed/owned by a member.
   */
  async listMemberVouchers(memberId: string, options?: RequestOptions): Promise<VoucherOwnershipDto[]> {
    return this.request<VoucherOwnershipDto[]>(`/v1/rewards/members/${memberId}/vouchers`, 'GET', undefined, options);
  }

  /**
   * Wait for an asynchronous operation reference to settle.
   */
  async waitForOperation(operationId: string): Promise<OperationReference> {
    return { operation_id: operationId };
  }
}

/**
 * Convenience factory to instantiate the client.
 */
export function createOctaPointClient(options: OctaPointClientOptions = {}): OctaPointClient {
  return new OctaPointClient(options);
}
