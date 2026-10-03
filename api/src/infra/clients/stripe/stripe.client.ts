import { Injectable } from '@nestjs/common';
/** Vendor adapter slot for stripe; no SDK instance, HTTP calls or connection. */
@Injectable()
export class StripeClient {}
