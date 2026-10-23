import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'octap:public';

/**
 * Opts a route (or a whole controller) out of `ApiKeyGuard`, which `AuthModule` applies to every
 * route by default. Only for callers that never hold a merchant API credential — the end
 * customer's own device — where something else is the proof of authorization (a Google id_token
 * Enoki validates, a zkLogin signature over a sponsored digest). Never combine with `@Tenant()`:
 * there is no tenant context on a public request.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
