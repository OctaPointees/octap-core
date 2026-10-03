import { Injectable } from '@nestjs/common';
import { ExpiryService } from './expiry.service.js';
/** Scaffold: coordinate a single expiry job. No job handling is implemented. */
@Injectable()
export class ExpiryProcessor {
  constructor(private readonly service: ExpiryService) {}
}
