import type {
  CreditBalanceSnapshot,
  LoyaltyTransactionDto,
  VoucherDto,
  ClaimVoucherResponse,
  VoucherOwnershipDto,
} from '@octap/contracts';

export interface BrowserClientOptions {
  apiBaseUrl: string;
  googleClientId?: string;
  organizationId?: string;
  getAuthToken?: () => Promise<string | null> | string | null;
}

export class OctaBrowserClient {
  private readonly apiBaseUrl: string;
  private readonly defaultOrganizationId?: string;
  private readonly getAuthToken?: () => Promise<string | null> | string | null;

  constructor(options: BrowserClientOptions) {
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, '');
    this.defaultOrganizationId = options.organizationId;
    this.getAuthToken = options.getAuthToken;
  }

  private async request<T>(
    path: string,
    method: 'GET' | 'POST' = 'GET',
    body?: unknown,
    orgId?: string,
  ): Promise<T> {
    const url = `${this.apiBaseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const headers: Record<string, string> = {
      'accept': 'application/json',
    };

    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    const organizationId = orgId ?? this.defaultOrganizationId;
    if (organizationId) {
      headers['x-organization-id'] = organizationId;
    }

    if (this.getAuthToken) {
      const token = await this.getAuthToken();
      if (token) {
        headers['authorization'] = `Bearer ${token}`;
      }
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      let errorBody: unknown = null;
      try {
        errorBody = await response.json();
      } catch {
        errorBody = await response.text();
      }
      throw new Error(
        typeof errorBody === 'object' && errorBody !== null && 'message' in errorBody
          ? String((errorBody as { message: unknown }).message)
          : `Octa Browser SDK request failed: ${response.status} ${response.statusText}`,
      );
    }

    return response.json() as Promise<T>;
  }

  /**
   * Get credit balance for a member.
   */
  async getBalance(memberId: string): Promise<CreditBalanceSnapshot> {
    return this.request<CreditBalanceSnapshot>(`/v1/credits/members/${memberId}/balance`, 'GET');
  }

  /**
   * List loyalty transactions for a member.
   */
  async listTransactions(memberId: string, limit = 50): Promise<LoyaltyTransactionDto[]> {
    return this.request<LoyaltyTransactionDto[]>(
      `/v1/credits/members/${memberId}/transactions?limit=${limit}`,
      'GET',
    );
  }

  /**
   * List active vouchers in the organization.
   */
  async listVouchers(organizationId?: string): Promise<VoucherDto[]> {
    return this.request<VoucherDto[]>('/v1/rewards/vouchers', 'GET', undefined, organizationId);
  }

  /**
   * Get details of a specific voucher.
   */
  async getVoucher(voucherId: string): Promise<VoucherDto> {
    return this.request<VoucherDto>(`/v1/rewards/vouchers/${voucherId}`, 'GET');
  }

  /**
   * Claim a voucher using loyalty points.
   */
  async claimVoucher(
    voucherId: string,
    organizationEndUserId: string,
    idempotencyKey?: string,
    organizationId?: string,
  ): Promise<ClaimVoucherResponse> {
    return this.request<ClaimVoucherResponse>(
      `/v1/rewards/vouchers/${voucherId}/claim`,
      'POST',
      {
        organizationEndUserId,
        idempotencyKey: idempotencyKey ?? `claim-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      },
      organizationId,
    );
  }

  /**
   * List all vouchers claimed/owned by a member.
   */
  async listMemberVouchers(memberId: string): Promise<VoucherOwnershipDto[]> {
    return this.request<VoucherOwnershipDto[]>(`/v1/rewards/members/${memberId}/vouchers`, 'GET');
  }
}

export function createBrowserClient(options: BrowserClientOptions): OctaBrowserClient {
  return new OctaBrowserClient(options);
}
