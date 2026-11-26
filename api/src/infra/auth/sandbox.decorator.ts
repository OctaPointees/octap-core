import { SetMetadata } from '@nestjs/common';

export const SANDBOX_SUPPORTED_KEY = 'octap:sandbox-supported';
export const SANDBOX_NOT_SUPPORTED = 'SANDBOX_NOT_SUPPORTED';

/**
 * Marks a write route that handles a SANDBOX key itself, against the sandbox ledger (OCT-297).
 * `ApiKeyGuard` refuses a sandbox key on every other non-GET route, so a new write route is closed
 * to sandbox keys until someone decides what it does in sandbox, rather than open by default.
 */
export const SandboxSupported = () => SetMetadata(SANDBOX_SUPPORTED_KEY, true);
