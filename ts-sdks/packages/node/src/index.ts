export {
  OctaPointClient,
  createOctaPointClient,
  type OctaPointClientOptions,
  type RequestOptions,
} from './client.js';

export {
  OctaSdkError,
  OctaApiError,
} from './errors/index.js';

export { verifyWebhookSignature, constructWebhookEvent } from './webhooks.js';

export type {
  Transport,
  RestTransport,
} from './transports/transport.js';

// Re-export contract types so consumers of @octap/sdk have immediate access to wire schemas
export type {
  Points,
  ActorContext,
  OperationReference,
  BalanceSnapshot,
  LoyaltyTxType,
  LoyaltyTxStatus,
  EarnPointsRequest,
  EarnPointsResponse,
  RedeemPointsRequest,
  RedeemPointsResponse,
  CreditBalanceSnapshot,
  LoyaltyTransactionDto,
  VoucherStatus,
  VoucherOwnershipStatus,
  DiscountType,
  CreateVoucherRequest,
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
  CreditsRedeemedEventData,
  CreditsChainConfirmedEventData,
} from '@octap/contracts';
