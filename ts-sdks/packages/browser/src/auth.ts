import { CoreApi, type RequestOptions } from './core-api.js';
import { OctapAuthError } from './errors.js';
import { createGoogleProvider, type IdTokenProvider } from './google-provider.js';
import {
  createSessionStore,
  type OctapUser,
  type Persistence,
  type SessionStore,
  type StoredSession,
} from './session-store.js';
import { PendingSignIn, idTokenExpiry, signWithZkLogin } from './zklogin-signer.js';

export interface OctapAuthOptions {
  apiBaseUrl: string;
  organizationId: string;
  googleClientId: string;
  /**
   * Where the signing key, proof and id_token are kept until `maxEpoch` or sign-out. `session` (the
   * default) survives a reload in this tab; `memory` does not. Any script running on your page can
   * read a `session` value, so an XSS flaw exposes it until it expires.
   */
  persistence?: Persistence;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface RenderOptions {
  /** Sign-in failures, including a customer closing Google's window. */
  onError?: (error: OctapAuthError) => void;
  /** Passed through to Google's button, such as `theme`, `size`, `text` or `shape`. */
  button?: Record<string, unknown>;
}

/** The merchant backend's claim result, as `@octap/sdk`'s `claimVoucher` returns it. */
export interface SignableClaim {
  status: string;
  digest?: string | null;
  transactionBytes?: string | null;
}

export interface FinalizedClaim {
  transactionId: string;
  organizationEndUserId: string;
  pointsRedeemed: number;
  newBalance: number;
  status: string;
  blockchainDigest: string;
}

export type AuthStateListener = (user: OctapUser | null) => void;

const DEFAULT_TIMEOUT_MS = 35_000;
/** Finalize waits for the chain's verdict, so it gets longer than an ordinary request. */
const FINALIZE_TIMEOUT_MS = 90_000;

export class OctapAuth {
  private readonly api: CoreApi;
  private readonly store: SessionStore;
  private readonly organizationId: string;
  private readonly googleClientId: string;
  private readonly listeners = new Set<AuthStateListener>();
  private session: StoredSession | null;
  private provider?: IdTokenProvider;
  private button?: { element: HTMLElement; options: RenderOptions };
  private signingIn = false;

  constructor(options: OctapAuthOptions) {
    const fetchFn = options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
    this.api = new CoreApi(options.apiBaseUrl, fetchFn, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.organizationId = options.organizationId;
    this.googleClientId = options.googleClientId;
    this.store = createSessionStore(options.persistence ?? 'session', options.organizationId);
    this.session = this.store.load();
    if (this.session && Date.now() >= this.session.signer.expiresAt) {
      this.store.clear();
      this.session = null;
    }
  }

  /** The signed-in customer, restored synchronously after a reload. */
  get currentUser(): OctapUser | null {
    return this.session?.user ?? null;
  }

  /** Calls `listener` with the current customer soon after subscribing, then on every change. */
  onAuthStateChanged(listener: AuthStateListener): () => void {
    this.listeners.add(listener);
    queueMicrotask(() => {
      if (this.listeners.has(listener)) listener(this.currentUser);
    });
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Renders Google's button. Key, nonce, enrollment and proof are handled when the customer uses it.
   * While a customer is signed in it renders nothing, and appears once they sign out or expire.
   */
  async renderGoogleButton(element: HTMLElement, options: RenderOptions = {}): Promise<void> {
    this.button = { element, options };
    this.provider = createGoogleProvider(this.googleClientId, options.button);
    if (!this.session) await this.arm();
  }

  /** The id_token for your backend to check with `@octap/sdk`'s `verifyCustomer`. */
  async getIdToken(): Promise<string> {
    const { idToken } = this.requireSession();
    const expiry = idTokenExpiry(idToken);
    if (expiry !== undefined && Date.now() >= expiry * 1000) {
      throw new OctapAuthError('token-expired', 'The sign-in token expired. Sign in again.');
    }
    return idToken;
  }

  /** Lower-level signing: returns the zkLogin signature over base64 transaction bytes. */
  async signTransaction(transactionBytes: string): Promise<string> {
    const session = this.requireSession();
    return signWithZkLogin(session.signer, session.user.suiAddress, transactionBytes);
  }

  /**
   * Signs a RESERVED claim and finalizes it. The voucher is not owned until this resolves.
   *
   * Never retried automatically. On `outcome-unknown` the transaction may still land, so read the
   * claim from your backend, or retry the claim with the same idempotency key. Use a new key only
   * after the claim is CANCELLED.
   */
  async signAndFinalize(claim: SignableClaim, options: RequestOptions = {}): Promise<FinalizedClaim> {
    if (claim.status !== 'RESERVED' || !claim.digest || !claim.transactionBytes) {
      throw new OctapAuthError('invalid-claim', 'Only a RESERVED claim with transaction bytes can be signed.');
    }
    const signature = await this.signTransaction(claim.transactionBytes);
    try {
      return await this.api.post<FinalizedClaim>(
        '/v1/credits/redeem/finalize',
        { digest: claim.digest, signature },
        { timeoutMs: FINALIZE_TIMEOUT_MS, ...options },
      );
    } catch (err: unknown) {
      throw isOutcomeKnown(err)
        ? err
        : new OctapAuthError(
            'outcome-unknown',
            'The result of this transaction is not known yet. Check the claim before trying again.',
            err instanceof OctapAuthError ? { status: err.status, body: err.body } : {},
          );
    }
  }

  async signOut(): Promise<void> {
    this.provider?.signOut();
    this.endSession();
    if (this.button) {
      // The button's nonce belongs to a key this session may have used, so issue a fresh one.
      await this.arm();
    }
  }

  private requireSession(): StoredSession {
    if (!this.session) {
      throw new OctapAuthError('not-signed-in', 'No customer is signed in.');
    }
    if (Date.now() >= this.session.signer.expiresAt) {
      this.endSession();
      if (this.button) void this.arm().catch((err: unknown) => this.reportError(err));
      throw new OctapAuthError('session-expired', 'The signing session expired. Sign in again.');
    }
    return this.session;
  }

  private endSession(): void {
    const hadSession = this.session !== null;
    this.store.clear();
    this.session = null;
    if (hadSession) this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.currentUser);
  }

  private reportError(err: unknown): void {
    const error =
      err instanceof OctapAuthError
        ? err
        : new OctapAuthError('provider-unavailable', err instanceof Error ? err.message : String(err));
    this.button?.options.onError?.(error);
  }

  /** Prepares a key and nonce and renders the button with them. */
  private async arm(): Promise<void> {
    const pending = await PendingSignIn.start(this.api);
    await this.provider!.render(this.button!.element, pending.nonce, {
      onIdToken: (idToken) => void this.completeSignIn(pending, idToken),
      onCanceled: () => this.reportError(new OctapAuthError('sign-in-canceled', 'Google sign-in was canceled.')),
    });
  }

  private async completeSignIn(pending: PendingSignIn, idToken: string): Promise<void> {
    if (this.signingIn) return;
    this.signingIn = true;
    try {
      pending.assertIssuedForThisAttempt(idToken);
      const { suiAddress } = await this.api.post<{ suiAddress: string }>('/v1/identity/google-login', { idToken });
      const { endUserId, organizationEndUserId } = await this.api.post<{
        endUserId: string;
        organizationEndUserId: string;
      }>(`/v1/identity/organizations/${encodeURIComponent(this.organizationId)}/enroll`, { idToken });
      const signer = await pending.prove(this.api, idToken);

      this.session = { user: { endUserId, memberId: organizationEndUserId, suiAddress }, idToken, signer };
      this.store.save(this.session);
      this.button?.element.replaceChildren();
      this.notify();
    } catch (err: unknown) {
      this.reportError(err);
      // A nonce is good for one attempt, so a failure must leave a usable button behind.
      await this.arm().catch((rearmError: unknown) => this.reportError(rearmError));
    } finally {
      this.signingIn = false;
    }
  }
}

/**
 * A 4xx means Core refused the request or the chain definitely failed it. The exceptions are a 408,
 * and a 409, which is how Core reports a digest that is still being resolved on-chain.
 */
function isOutcomeKnown(err: unknown): boolean {
  if (!(err instanceof OctapAuthError) || err.code !== 'api-error' || err.status === undefined) return false;
  return err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 409;
}

export function createOctapAuth(options: OctapAuthOptions): OctapAuth {
  return new OctapAuth(options);
}
