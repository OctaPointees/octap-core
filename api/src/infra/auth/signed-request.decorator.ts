import { SetMetadata } from '@nestjs/common';

export const REQUIRE_SIGNED_REQUEST_KEY = 'octap:require-signed-request';

/**
 * Marks a route as requiring HMAC request signing (X-OctaP-Timestamp/-Nonce/-Signature) on
 * top of the bearer key, enforced by ApiKeyGuard. Opt-in per route, not global: existing
 * clients that only send Authorization: Bearer would otherwise break on every route at once.
 */
export const RequireSignedRequest = () => SetMetadata(REQUIRE_SIGNED_REQUEST_KEY, true);
