import { Injectable } from '@nestjs/common';
/** Vendor adapter slot for merchant-webhooks; no SDK instance, HTTP calls or connection. */
@Injectable()
export class MerchantWebhooksClient {}
