export type OctapAuthErrorCode =
  /** The customer closed Google's sign-in window. */
  | 'sign-in-canceled'
  /** Google's token was not issued for this sign-in attempt. */
  | 'nonce-mismatch'
  /** Google's sign-in script could not load, or the SDK ran outside a browser. */
  | 'provider-unavailable'
  /** No customer is signed in. */
  | 'not-signed-in'
  /** The signing session passed its `maxEpoch`, so the customer must sign in again. */
  | 'session-expired'
  /** Google's id_token expired. The signing session may still work, but the backend will refuse the token. */
  | 'token-expired'
  /** The transaction is for a different address than the signed-in customer's. */
  | 'wrong-account'
  /** The claim has nothing to sign, such as a free reward that is already AVAILABLE. */
  | 'invalid-claim'
  /** Finalize may have reached the chain. Read the claim's state; do not sign again with a new key. */
  | 'outcome-unknown'
  /** The server answered with an error; see `status` and `body`. */
  | 'api-error'
  | 'network-error'
  | 'timeout'
  | 'aborted'
  /** The server answered successfully, with a body this SDK cannot use. */
  | 'invalid-response';

export class OctapAuthError extends Error {
  readonly code: OctapAuthErrorCode;
  readonly status?: number;
  readonly body?: unknown;

  constructor(code: OctapAuthErrorCode, message: string, details: { status?: number; body?: unknown } = {}) {
    super(message);
    this.name = 'OctapAuthError';
    this.code = code;
    this.status = details.status;
    this.body = details.body;
  }
}
