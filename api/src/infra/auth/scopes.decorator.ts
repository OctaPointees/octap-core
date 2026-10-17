import { SetMetadata } from '@nestjs/common';

export const SCOPES_KEY = 'octap:required-scopes';

/** Declares the API-credential scopes a route requires; enforced by `ApiKeyGuard`. */
export const Scopes = (...scopes: string[]) => SetMetadata(SCOPES_KEY, scopes);
