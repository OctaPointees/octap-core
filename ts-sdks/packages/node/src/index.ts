export { OctaPointClient, createOctaPointClient, type OctaPointClientOptions, type RequestOptions } from './client.js';

export { OctaSdkError, OctaApiError, OctaNetworkError, OctaRequestAbortedError } from './errors/index.js';

export { verifyWebhookSignature, constructWebhookEvent } from './webhooks.js';

export type { Transport, RestTransport } from './transports/transport.js';

// Re-export contract types so consumers of @octap/sdk have immediate access to wire schemas
export type {
  Points,
  BalanceSnapshot,
  LoyaltyTxType,
  LoyaltyTxStatus,
  EarnPointsRequest,
  EarnPointsResponse,
  ReservePosRedemptionRequest,
  ReservePosRedemptionResponse,
  FinalizePosRedemptionRequest,
  FinalizePosRedemptionResponse,
  ReverseTransactionRequest,
  ReverseTransactionResponse,
  CreditBalanceSnapshot,
  LoyaltyTransactionDto,
  VoucherRefundPolicy,
  VoucherRefundPolicySnapshot,
  SetVoucherRefundPolicyRequest,
  ListVoucherRefundPolicyHistoryRequest,
  VoucherRefundPolicyDto,
  VoucherStatus,
  VoucherOwnershipStatus,
  DiscountType,
  CreateVoucherRequest,
  UpdateVoucherRequest,
  VoucherDto,
  ClaimVoucherRequest,
  ClaimVoucherResponse,
  RedeemVoucherRequest,
  RedeemVoucherResponse,
  VoucherOwnershipDto,
  WebhookEndpointStatus,
  WebhookDeliveryStatus,
  WebhookEndpointDto,
  WebhookEndpointWithSecretDto,
  RegisterWebhookEndpointRequest,
  WebhookDeliveryDto,
  WebhookEventType,
  WebhookEvent,
  CreditsEarnedEventData,
  CreditsChainConfirmedEventData,
} from '@octap/contracts';
