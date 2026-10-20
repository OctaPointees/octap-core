export type WebhookEndpointStatus = 'ACTIVE' | 'DISABLED';
export type WebhookDeliveryStatus = 'PENDING' | 'DELIVERED' | 'DEAD_LETTER';

export interface WebhookEndpointDto {
  id: string;
  organizationId: string;
  url: string;
  description?: string | null;
  status: WebhookEndpointStatus;
  createdAt: string;
  updatedAt: string;
}

/** Only ever returned on register/rotate — the secret is never included in a list or get. */
export interface WebhookEndpointWithSecretDto extends WebhookEndpointDto {
  secret: string;
}

export interface RegisterWebhookEndpointRequest {
  url: string;
  description?: string;
}

export interface WebhookDeliveryDto {
  id: string;
  endpointId: string;
  eventType: string;
  status: WebhookDeliveryStatus;
  attemptCount: number;
  nextAttemptAt: string;
  lastResponseStatus?: number | null;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
}
