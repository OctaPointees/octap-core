import { CoreApi, normalizeBaseUrl, type RequestOptions } from './core-api.js';
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

/** What `prepareVoucherUse` returned on the merchant's server. */
export interface SignableVoucherUse {
  digest?: string | null;
  transactionBytes?: string | null;
}

export interface FinalizedVoucherUse {
  voucherOwnershipId: string;
  voucherId: string;
  serialCode: string;
  status: string;
  redeemedAt: string;
  voucherTitle: string;
  discountType?: string | null;
  discountValue?: string | null;
  blockchainDigest: string;
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
/** Browsers run a longer `setTimeout` immediately. */
const MAX_TIMER_MS = 2_147_483_647;

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
  /** Changes when the session ends, so a sign-in still running cannot bring it back. */
  private signInGeneration = 0;
  /** Changes on each new button, so only the latest nonce can be rendered or used. */
  private armGeneration = 0;
  private expiryTimer?: number;

  constructor(options: OctapAuthOptions) {
    const fetchFn = options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
    this.api = new CoreApi(options.apiBaseUrl, fetchFn, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.organizationId = options.organizationId;
    this.googleClientId = options.googleClientId;
    this.store = createSessionStore(options.persistence ?? 'session', {
      apiBaseUrl: normalizeBaseUrl(options.apiBaseUrl),
      googleClientId: options.googleClientId,
      organizationId: options.organizationId,
    });
    this.session = this.store.load();
    if (this.session && Date.now() >= this.session.signer.expiresAt) {
      this.store.clear();
      this.session = null;
    }
    this.scheduleExpiry();
  }

  /** The signed-in customer, restored synchronously after a reload. Null once the session expires. */
  get currentUser(): OctapUser | null {
    return this.session && Date.now() < this.session.signer.expiresAt ? this.session.user : null;
  }

  /** Calls `listener` with the current customer soon after subscribing, then on every change. */
  onAuthStateChanged(listener: AuthStateListener): () => void {
    this.listeners.add(listener);
    queueMicrotask(() => {
      if (this.listeners.has(listener)) this.call(listener);
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
    if (!this.currentUser) await this.arm();
  }

  /**
   * The id_token for your backend to check with `@octap/sdk`'s `verifyCustomer`. Google's token lasts
   * about an hour. When it has expired the customer is signed out, so the button returns for a new one.
   */
  async getIdToken(): Promise<string> {
    const { idToken } = this.requireSession();
    const expiry = idTokenExpiry(idToken);
    if (expiry !== undefined && Date.now() >= expiry * 1000) {
      this.expireSession();
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
   * Never retried automatically. On `outcome-unknown` the transaction may have failed or may still
   * land, so read the claim from your backend, or retry the claim with the same idempotency key. Use
   * a new key only after the claim is CANCELLED.
   */
  async signAndFinalize(claim: SignableClaim, options: RequestOptions = {}): Promise<FinalizedClaim> {
    if (claim.status !== 'RESERVED' || !claim.digest || !claim.transactionBytes) {
      throw new OctapAuthError('invalid-claim', 'Only a RESERVED claim with transaction bytes can be signed.');
    }
    return this.submitSigned<FinalizedClaim>(
      '/v1/credits/redeem/finalize',
      claim.digest,
      claim.transactionBytes,
      options,
    );
  }

  /**
   * Signs the customer's use of a voucher and finalizes it. Show the customer what they are using
   * first: this signature is the only thing that can mark their voucher used. Never retried
   * automatically; on `outcome-unknown`, read the voucher from your backend.
   */
  async signAndFinalizeVoucherUse(use: SignableVoucherUse, options: RequestOptions = {}): Promise<FinalizedVoucherUse> {
    if (!use.digest || !use.transactionBytes) {
      throw new OctapAuthError('invalid-claim', 'Only a voucher use with transaction bytes can be signed.');
    }
    return this.submitSigned<FinalizedVoucherUse>(
      '/v1/rewards/vouchers/use/finalize',
      use.digest,
      use.transactionBytes,
      options,
    );
  }

  private async submitSigned<T>(
    path: string,
    digest: string,
    transactionBytes: string,
    options: RequestOptions,
  ): Promise<T> {
    const signature = await this.signTransaction(transactionBytes);
    try {
      return await this.api.post<T>(
        path,
        { digest, signature },
        { ...options, timeoutMs: options.timeoutMs ?? FINALIZE_TIMEOUT_MS },
      );
    } catch (err: unknown) {
      // Core answers 400 for a bad signature and for an Enoki failure after sending alike, and 404 for
      // a repeat of a finalize that already succeeded. Only a rate limit proves nothing was attempted.
      throw err instanceof OctapAuthError && err.status === 429
        ? err
        : new OctapAuthError(
            'outcome-unknown',
            'The result of this transaction is not known yet. Check the claim before trying again.',
            err instanceof OctapAuthError ? { status: err.status, body: err.body } : {},
          );
    }
  }

  /** Always ends the session. A button that cannot return is reported through `onError`. */
  async signOut(): Promise<void> {
    this.provider?.signOut();
    this.endSession();
    // The button's nonce belongs to a key this session may have used, so issue a fresh one.
    await this.rearm();
  }

  private requireSession(): StoredSession {
    if (!this.session) {
      throw new OctapAuthError('not-signed-in', 'No customer is signed in.');
    }
    if (Date.now() >= this.session.signer.expiresAt) {
      this.expireSession();
      throw new OctapAuthError('session-expired', 'The signing session expired. Sign in again.');
    }
    return this.session;
  }

  private expireSession(): void {
    this.endSession();
    void this.rearm();
  }

  private endSession(): void {
    const hadSession = this.session !== null;
    this.signInGeneration++;
    this.signingIn = false;
    this.store.clear();
    this.session = null;
    this.scheduleExpiry();
    if (hadSession) this.notify();
  }

  /** Lets an open page notice expiry without waiting for a call to fail. Only runs in a browser. */
  private scheduleExpiry(): void {
    if (typeof window === 'undefined') return;
    window.clearTimeout(this.expiryTimer);
    if (!this.session) return;
    const remaining = this.session.signer.expiresAt - Date.now();
    this.expiryTimer = window.setTimeout(
      () => {
        if (this.session && Date.now() >= this.session.signer.expiresAt) this.expireSession();
        else this.scheduleExpiry();
      },
      Math.min(Math.max(remaining, 0), MAX_TIMER_MS),
    );
  }

  private notify(): void {
    for (const listener of this.listeners) this.call(listener);
  }

  /** One merchant listener's bug must not undo a sign-in, or stop the other listeners. */
  private call(listener: AuthStateListener): void {
    try {
      listener(this.currentUser);
    } catch (err: unknown) {
      console.error('An onAuthStateChanged listener threw:', err);
    }
  }

  private reportError(err: unknown): void {
    const error =
      err instanceof OctapAuthError
        ? err
        : new OctapAuthError('provider-unavailable', err instanceof Error ? err.message : String(err));
    try {
      this.button?.options.onError?.(error);
    } catch (handlerError: unknown) {
      console.error('The onError handler threw:', handlerError);
    }
  }

  /** Puts a usable button back, if one was rendered, reporting rather than throwing a failure. */
  private async rearm(): Promise<void> {
    if (!this.button) return;
    await this.arm().catch((err: unknown) => this.reportError(err));
  }

  /** Prepares a key and nonce and renders the button with them. A newer call replaces an older one. */
  private async arm(): Promise<void> {
    const generation = ++this.armGeneration;
    const pending = await PendingSignIn.start(this.api);
    if (generation !== this.armGeneration) return;
    await this.provider!.render(this.button!.element, pending.nonce, {
      onIdToken: (idToken) => {
        if (generation === this.armGeneration) void this.completeSignIn(pending, idToken);
      },
      onCanceled: () => {
        if (generation === this.armGeneration) {
          this.reportError(new OctapAuthError('sign-in-canceled', 'Google sign-in was canceled.'));
        }
      },
    });
  }

  private async completeSignIn(pending: PendingSignIn, idToken: string): Promise<void> {
    if (this.signingIn) return;
    this.signingIn = true;
    const generation = this.signInGeneration;
    const superseded = () => generation !== this.signInGeneration;
    try {
      pending.assertIssuedForThisAttempt(idToken);
      const { suiAddress } = await this.api.post<{ suiAddress: string }>('/v1/identity/google-login', { idToken });
      if (superseded()) return;
      const { endUserId, organizationEndUserId } = await this.api.post<{
        endUserId: string;
        organizationEndUserId: string;
      }>(`/v1/identity/organizations/${encodeURIComponent(this.organizationId)}/enroll`, { idToken });
      if (superseded()) return;
      if (
        typeof suiAddress !== 'string' ||
        typeof endUserId !== 'string' ||
        typeof organizationEndUserId !== 'string'
      ) {
        throw new OctapAuthError('invalid-response', 'OctaP returned an incomplete customer.');
      }
      const signer = await pending.prove(this.api, idToken);
      if (superseded()) return;

      this.session = { user: { endUserId, memberId: organizationEndUserId, suiAddress }, idToken, signer };
      this.store.save(this.session);
      this.scheduleExpiry();
      // A button armed for another attempt must not outlive this session's sign-in.
      this.armGeneration++;
      this.button?.element.replaceChildren();
      this.notify();
    } catch (err: unknown) {
      if (superseded()) return;
      this.reportError(err);
      // A nonce is good for one attempt, so a failure must leave a usable button behind.
      await this.rearm();
    } finally {
      if (!superseded()) this.signingIn = false;
    }
  }
}

export function createOctapAuth(options: OctapAuthOptions): OctapAuth {
  return new OctapAuth(options);
}
