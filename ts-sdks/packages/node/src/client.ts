import type {
  BalanceSnapshot,
  EarnPointsRequest,
  EarnPointsResponse,
  IssuanceBudgetDto,
  CreditBalanceSnapshot,
  LoyaltyTransactionDto,
  CreateVoucherRequest,
  UpdateVoucherRequest,
  VoucherDto,
  ClaimVoucherRequest,
  ClaimVoucherResponse,
  FinalizePosRedemptionRequest,
  FinalizePosRedemptionResponse,
  GrantVoucherRequest,
  PrepareVoucherUseRequest,
  PrepareVoucherUseResponse,
  FinalizeVoucherUseRequest,
  RedeemVoucherResponse,
  VoucherOwnershipDto,
  SetVoucherRefundPolicyRequest,
  ListVoucherRefundPolicyHistoryRequest,
  VoucherRefundPolicyDto,
  VerifyCustomerResponse,
  ReservePosRedemptionRequest,
  ReservePosRedemptionResponse,
  ReverseTransactionRequest,
  ReverseTransactionResponse,
  WebhookEndpointDto,
  WebhookEndpointWithSecretDto,
  RegisterWebhookEndpointRequest,
  WebhookDeliveryDto,
} from '@octap/contracts';
import type { Transport } from './transports/transport.js';
import { OctaApiError, OctaSdkError, OctaNetworkError, OctaRequestAbortedError } from './errors/index.js';

function toTransportError(err: unknown, signal?: AbortSignal): OctaSdkError {
  return signal?.aborted || (err instanceof Error && err.name === 'AbortError')
    ? new OctaRequestAbortedError(err)
    : new OctaNetworkError(err);
}

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
      throw toTransportError(err, options?.signal);
    }

    let responseData: unknown = null;
    const contentType = response.headers.get('content-type') ?? '';
    try {
      responseData = contentType.includes('application/json') ? await response.json() : await response.text();
    } catch (err: unknown) {
      if (!(err instanceof SyntaxError)) throw toTransportError(err, options?.signal);
    }

    if (!response.ok) {
      throw new OctaApiError(
        response.status,
        response.statusText,
        responseData,
        undefined,
        response.headers.get('retry-after') ?? undefined,
      );
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
   * Get the credit balance snapshot for a member.
   */
  async getBalance(memberId: string, options?: RequestOptions): Promise<CreditBalanceSnapshot>;
  async getBalance(programId: string, memberId: string, options?: RequestOptions): Promise<BalanceSnapshot>;
  async getBalance(
    arg1: string,
    arg2?: string | RequestOptions,
    options?: RequestOptions,
  ): Promise<CreditBalanceSnapshot | BalanceSnapshot> {
    const programId = typeof arg2 === 'string' ? arg1 : undefined;
    const memberId = typeof arg2 === 'string' ? arg2 : arg1;
    const snapshot = await this.request<CreditBalanceSnapshot>(
      `/v1/credits/members/${encodeURIComponent(memberId)}/balance`,
      'GET',
      undefined,
      typeof arg2 === 'string' ? options : arg2,
      { programId },
    );
    if (programId === undefined) return snapshot;
    return {
      confirmed_balance: String(snapshot.confirmedBalance),
      pending_earn: String(snapshot.pendingEarn),
      pending_redemption: String(snapshot.pendingRedemption),
      as_of_checkpoint: snapshot.asOfCheckpoint ?? '0',
      observed_at: snapshot.observedAt,
      stale: snapshot.stale,
    };
  }

  /** How many more points your program may issue, read live from the chain. */
  async getIssuanceBudget(options?: RequestOptions): Promise<IssuanceBudgetDto> {
    return this.request('/v1/credits/budget', 'GET', undefined, options);
  }

  /** Reserve POS points; return the bytes to the customer's signing session. */
  async reservePosRedemption(
    request: ReservePosRedemptionRequest,
    options?: RequestOptions,
  ): Promise<ReservePosRedemptionResponse> {
    return this.request('/v1/credits/redeem/reserve', 'POST', request, options);
  }

  /** Submit the customer's signature. Cancellation does not undo a submitted transaction. */
  async finalizePosRedemption(
    request: FinalizePosRedemptionRequest,
    options?: RequestOptions,
  ): Promise<FinalizePosRedemptionResponse> {
    return this.request('/v1/credits/redeem/finalize', 'POST', request, options);
  }

  async reverseTransaction(
    request: ReverseTransactionRequest,
    options?: RequestOptions,
  ): Promise<ReverseTransactionResponse> {
    const { transactionId, ...body } = request;
    return this.request(`/v1/credits/transactions/${encodeURIComponent(transactionId)}/reverse`, 'POST', body, options);
  }

  /**
   * List loyalty transactions for a member.
   */
  async listTransactions(
    memberId: string,
    options?: RequestOptions & { limit?: number },
  ): Promise<LoyaltyTransactionDto[]> {
    return this.request<LoyaltyTransactionDto[]>(
      `/v1/credits/members/${encodeURIComponent(memberId)}/transactions`,
      'GET',
      undefined,
      options,
      { limit: options?.limit },
    );
  }

  // ==========================================
  // REWARDS & VOUCHERS API
  // ==========================================

  /** The policy the next published voucher takes. A published voucher keeps the one it was published with. */
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

  /**
   * Create a new voucher definition. A `code` already used in your organization is a 409: if a create
   * timed out or its response was lost, the voucher may exist anyway, so find it with `listVouchers`
   * instead of creating it again.
   */
  async createVoucher(request: CreateVoucherRequest, options?: RequestOptions): Promise<VoucherDto> {
    return this.request<VoucherDto>('/v1/rewards/vouchers', 'POST', request, options);
  }

  /** Edit a reward or set its status to DRAFT, ACTIVE or PAUSED. */
  async updateVoucher(voucherId: string, request: UpdateVoucherRequest, options?: RequestOptions): Promise<VoucherDto> {
    return this.request<VoucherDto>(`/v1/rewards/vouchers/${encodeURIComponent(voucherId)}`, 'PATCH', request, options);
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
    return this.request<VoucherDto>(`/v1/rewards/vouchers/${encodeURIComponent(voucherId)}`, 'GET', undefined, options);
  }

  /**
   * Reserve a voucher; paid claims return customer-signable bytes and remain RESERVED until chain confirmation.
   */
  async claimVoucher(
    voucherId: string,
    request: ClaimVoucherRequest,
    options?: RequestOptions,
  ): Promise<ClaimVoucherResponse> {
    return this.request<ClaimVoucherResponse>(
      `/v1/rewards/vouchers/${encodeURIComponent(voucherId)}/claim`,
      'POST',
      request,
      options,
    );
  }

  /** Read persisted claim state after finalize or asynchronous chain recovery. */
  async getVoucherClaim(ownershipId: string, options?: RequestOptions): Promise<ClaimVoucherResponse> {
    return this.request<ClaimVoucherResponse>(
      `/v1/rewards/claims/${encodeURIComponent(ownershipId)}`,
      'GET',
      undefined,
      options,
    );
  }

  /** The customer signs returned transactionBytes with their zkLogin session; no merchant key is needed by finalize. */
  async finalizeVoucherClaim(
    request: FinalizePosRedemptionRequest,
    options?: RequestOptions,
  ): Promise<FinalizePosRedemptionResponse> {
    return this.request<FinalizePosRedemptionResponse>('/v1/credits/redeem/finalize', 'POST', request, options);
  }

  /**
   * Give a customer a voucher without spending their points. It stays RESERVED until the chain
   * records it; `voucher.granted` reports that.
   */
  async grantVoucher(
    voucherId: string,
    request: GrantVoucherRequest,
    options?: RequestOptions,
  ): Promise<ClaimVoucherResponse> {
    return this.request<ClaimVoucherResponse>(
      `/v1/rewards/vouchers/${encodeURIComponent(voucherId)}/grant`,
      'POST',
      request,
      options,
    );
  }

  /**
   * Ask the customer to use a voucher. Returns bytes for their device to sign: your API key cannot
   * mark a voucher used. Deliver the benefit on the `voucher.redeemed` webhook.
   */
  async prepareVoucherUse(
    request: PrepareVoucherUseRequest,
    options?: RequestOptions,
  ): Promise<PrepareVoucherUseResponse> {
    return this.request<PrepareVoucherUseResponse>('/v1/rewards/vouchers/use', 'POST', request, options);
  }

  /** The customer signs the returned bytes with their zkLogin session; finalize needs no merchant key. */
  async finalizeVoucherUse(
    request: FinalizeVoucherUseRequest,
    options?: RequestOptions,
  ): Promise<RedeemVoucherResponse> {
    return this.request<RedeemVoucherResponse>('/v1/rewards/vouchers/use/finalize', 'POST', request, options);
  }

  /**
   * List all vouchers claimed/owned by a member.
   */
  async listMemberVouchers(memberId: string, options?: RequestOptions): Promise<VoucherOwnershipDto[]> {
    return this.request<VoucherOwnershipDto[]>(
      `/v1/rewards/members/${encodeURIComponent(memberId)}/vouchers`,
      'GET',
      undefined,
      options,
    );
  }

  async registerWebhookEndpoint(
    request: RegisterWebhookEndpointRequest,
    options?: RequestOptions,
  ): Promise<WebhookEndpointWithSecretDto> {
    return this.request('/v1/webhooks/endpoints', 'POST', request, options);
  }

  async listWebhookEndpoints(options?: RequestOptions): Promise<WebhookEndpointDto[]> {
    return this.request('/v1/webhooks/endpoints', 'GET', undefined, options);
  }

  async disableWebhookEndpoint(id: string, options?: RequestOptions): Promise<WebhookEndpointDto> {
    return this.request(`/v1/webhooks/endpoints/${encodeURIComponent(id)}/disable`, 'POST', undefined, options);
  }

  async enableWebhookEndpoint(id: string, options?: RequestOptions): Promise<WebhookEndpointDto> {
    return this.request(`/v1/webhooks/endpoints/${encodeURIComponent(id)}/enable`, 'POST', undefined, options);
  }

  async rotateWebhookSecret(id: string, options?: RequestOptions): Promise<WebhookEndpointWithSecretDto> {
    return this.request(`/v1/webhooks/endpoints/${encodeURIComponent(id)}/rotate-secret`, 'POST', undefined, options);
  }

  async listWebhookDeliveries(options?: RequestOptions): Promise<WebhookDeliveryDto[]> {
    return this.request('/v1/webhooks/deliveries', 'GET', undefined, options);
  }

  async replayWebhookDelivery(id: string, options?: RequestOptions): Promise<WebhookDeliveryDto> {
    return this.request(`/v1/webhooks/deliveries/${encodeURIComponent(id)}/replay`, 'POST', undefined, options);
  }
}

/**
 * Convenience factory to instantiate the client.
 */
export function createOctaPointClient(options: OctaPointClientOptions = {}): OctaPointClient {
  return new OctaPointClient(options);
}
