import type {
  CreditBalanceSnapshot,
  LoyaltyTransactionDto,
  VoucherDto,
  ClaimVoucherResponse,
  FinalizePosRedemptionRequest,
  FinalizePosRedemptionResponse,
  VoucherOwnershipDto,
  GoogleLoginResponse,
  EnrollMemberResponse,
  ConsoleIdentity,
  OrganizationApplicationInput,
  OrganizationProfileInput,
  OrganizationApplication,
  ConsoleOrganization,
  ConsoleStaff,
  ConsoleInvitation,
  CreatedConsoleInvitation,
  ConsoleCredential,
} from '@octap/contracts';

export interface BrowserClientOptions {
  apiBaseUrl: string;
  googleClientId?: string;
  organizationId?: string;
  getAuthToken?: () => Promise<string | null> | string | null;
}

export class OctaBrowserClient {
  private consoleRequest<T>(
    path: string,
    method: 'GET' | 'POST' | 'PATCH' = 'GET',
    body?: unknown,
    signal?: AbortSignal,
  ) {
    return this.request<T>(path, method, body, undefined, { cache: 'no-store', signal });
  }
  requestConsoleOrganization(input: OrganizationApplicationInput, signal?: AbortSignal) {
    return this.consoleRequest<{ id: string }>('/v1/console/organization-requests', 'POST', input, signal);
  }
  listConsoleOrganizationRequests(signal?: AbortSignal) {
    return this.consoleRequest<OrganizationApplication[]>(
      '/v1/console/organization-requests',
      'GET',
      undefined,
      signal,
    );
  }
  listPlatformOrganizationRequests(signal?: AbortSignal) {
    return this.consoleRequest<OrganizationApplication[]>(
      '/v1/platform/organization-requests',
      'GET',
      undefined,
      signal,
    );
  }
  decidePlatformOrganizationRequest(id: string, decision: 'approve' | 'reject', reason?: string, signal?: AbortSignal) {
    return this.consoleRequest<{ organizationId: string }>(
      `/v1/platform/organization-requests/${encodeURIComponent(id)}/${decision}`,
      'POST',
      { reason },
      signal,
    );
  }
  getConsoleOrganization(id: string, signal?: AbortSignal) {
    return this.consoleRequest<ConsoleOrganization>(
      `/v1/console/organizations/${encodeURIComponent(id)}`,
      'GET',
      undefined,
      signal,
    );
  }
  updateConsoleOrganizationProfile(id: string, input: OrganizationProfileInput, signal?: AbortSignal) {
    return this.consoleRequest<{ updated: boolean }>(
      `/v1/console/organizations/${encodeURIComponent(id)}/profile`,
      'PATCH',
      input,
      signal,
    );
  }
  listConsoleStaff(id: string, signal?: AbortSignal) {
    return this.consoleRequest<ConsoleStaff[]>(
      `/v1/console/organizations/${encodeURIComponent(id)}/staff`,
      'GET',
      undefined,
      signal,
    );
  }
  listConsoleCredentials(id: string, signal?: AbortSignal) {
    return this.consoleRequest<ConsoleCredential[]>(
      `/v1/console/organizations/${encodeURIComponent(id)}/api-credentials`,
      'GET',
      undefined,
      signal,
    );
  }
  createConsoleInvitation(id: string, email: string, signal?: AbortSignal) {
    return this.consoleRequest<CreatedConsoleInvitation>(
      `/v1/console/organizations/${encodeURIComponent(id)}/invitations`,
      'POST',
      { email, persona: 'BUSINESS_DEVELOPER' },
      signal,
    );
  }
  listConsoleInvitations(id: string, signal?: AbortSignal) {
    return this.consoleRequest<ConsoleInvitation[]>(
      `/v1/console/organizations/${encodeURIComponent(id)}/invitations`,
      'GET',
      undefined,
      signal,
    );
  }
  revokeConsoleInvitation(id: string, invitationId: string, signal?: AbortSignal) {
    return this.consoleRequest<{ revoked: boolean }>(
      `/v1/console/organizations/${encodeURIComponent(id)}/invitations/${encodeURIComponent(invitationId)}/revoke`,
      'POST',
      undefined,
      signal,
    );
  }
  acceptConsoleInvitation(token: string, signal?: AbortSignal) {
    return this.consoleRequest<{ organizationId: string }>(
      `/v1/console/invitations/${encodeURIComponent(token)}/accept`,
      'POST',
      undefined,
      signal,
    );
  }
  /** Direct portal Google login; separate from customer Google/Enoki wallet enrollment. */
  async loginConsoleWithGoogle(idToken: string, options: { signal?: AbortSignal } = {}): Promise<ConsoleIdentity> {
    return this.request<ConsoleIdentity>('/v1/console/auth/google', 'POST', { idToken }, undefined, {
      ...options,
      cache: 'no-store',
    });
  }

  /** getAuthToken must return the current Google ID token for this console request. */
  async getConsoleIdentity(options: { signal?: AbortSignal } = {}): Promise<ConsoleIdentity> {
    return this.request<ConsoleIdentity>('/v1/console/me', 'GET', undefined, undefined, {
      ...options,
      cache: 'no-store',
    });
  }
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
    method: 'GET' | 'POST' | 'PATCH' = 'GET',
    body?: unknown,
    orgId?: string,
    options?: Pick<RequestInit, 'signal' | 'cache'>,
  ): Promise<T> {
    const url = `${this.apiBaseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const headers: Record<string, string> = {
      accept: 'application/json',
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
      ...options,
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
    return this.request<LoyaltyTransactionDto[]>(`/v1/credits/members/${memberId}/transactions?limit=${limit}`, 'GET');
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

  /** Read persisted claim state after finalize or asynchronous chain recovery. */
  async getVoucherClaim(ownershipId: string): Promise<ClaimVoucherResponse> {
    return this.request<ClaimVoucherResponse>(`/v1/rewards/claims/${ownershipId}`, 'GET');
  }

  /** The customer signs returned transactionBytes with their zkLogin session; no merchant key is needed by finalize. */
  async finalizeVoucherClaim(request: FinalizePosRedemptionRequest): Promise<FinalizePosRedemptionResponse> {
    return this.request<FinalizePosRedemptionResponse>('/v1/credits/redeem/finalize', 'POST', request);
  }

  /**
   * List all vouchers claimed/owned by a member.
   */
  async listMemberVouchers(memberId: string): Promise<VoucherOwnershipDto[]> {
    return this.request<VoucherOwnershipDto[]>(`/v1/rewards/members/${memberId}/vouchers`, 'GET');
  }

  /**
   * Resolves a Google id_token (obtained from the host app's own Google Sign-In; this SDK does
   * not render a sign-in button) to a zkLogin Sui address and a global end-user identity.
   */
  async loginWithGoogle(idToken: string): Promise<GoogleLoginResponse> {
    return this.request<GoogleLoginResponse>('/v1/identity/google-login', 'POST', { idToken });
  }

  /**
   * Enrolls an already-logged-in end user into one organization's loyalty program.
   */
  async enroll(endUserId: string, organizationId?: string, externalMemberId?: string): Promise<EnrollMemberResponse> {
    const orgId = organizationId ?? this.defaultOrganizationId;
    if (!orgId) {
      throw new Error('organizationId is required (pass it or set BrowserClientOptions.organizationId)');
    }
    return this.request<EnrollMemberResponse>(`/v1/identity/organizations/${orgId}/enroll`, 'POST', {
      endUserId,
      externalMemberId,
    });
  }
}

export function createBrowserClient(options: BrowserClientOptions): OctaBrowserClient {
  return new OctaBrowserClient(options);
}
