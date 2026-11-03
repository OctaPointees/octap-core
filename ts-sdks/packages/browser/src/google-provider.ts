import { OctapAuthError } from './errors.js';

/**
 * Provider sign-in: turns a click into an id_token bound to a nonce. Nothing outside this file knows
 * it is Google, which keeps a later provider a change here, not in the public API.
 */
export interface SignInHandlers {
  onIdToken(idToken: string): void;
  onCanceled(): void;
}

export interface IdTokenProvider {
  render(element: HTMLElement, nonce: string, handlers: SignInHandlers): Promise<void>;
  signOut(): void;
}

interface GoogleIdentity {
  initialize(options: {
    client_id: string;
    callback: (response: { credential: string }) => void;
    auto_select: boolean;
    nonce: string;
  }): void;
  renderButton(element: HTMLElement, options: Record<string, unknown>): void;
  disableAutoSelect(): void;
}

type GoogleWindow = Window & { google?: { accounts?: { id?: GoogleIdentity } } };

const SCRIPT_URL = 'https://accounts.google.com/gsi/client';
const SCRIPT_TIMEOUT_MS = 20_000;
/** A credential can arrive just after the popup closes, so wait before calling it a cancellation. */
const CANCEL_GRACE_MS = 1_500;

let loading: Promise<GoogleIdentity> | undefined;

function loadGoogleIdentity(): Promise<GoogleIdentity> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.reject(new OctapAuthError('provider-unavailable', 'Google sign-in needs a browser.'));
  }
  const loaded = (window as GoogleWindow).google?.accounts?.id;
  if (loaded) return Promise.resolve(loaded);
  if (loading) return loading;

  loading = new Promise<GoogleIdentity>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.async = true;
    const fail = () => {
      window.clearTimeout(timer);
      script.remove();
      loading = undefined;
      reject(new OctapAuthError('provider-unavailable', 'Google sign-in could not load.'));
    };
    const timer = window.setTimeout(fail, SCRIPT_TIMEOUT_MS);
    script.onerror = fail;
    script.onload = () => {
      const google = (window as GoogleWindow).google?.accounts?.id;
      if (!google) {
        fail();
        return;
      }
      window.clearTimeout(timer);
      resolve(google);
    };
    document.head.appendChild(script);
  });
  return loading;
}

export function createGoogleProvider(clientId: string, buttonOptions: Record<string, unknown> = {}): IdTokenProvider {
  let google: GoogleIdentity | undefined;
  let stopWatching: (() => void) | undefined;

  return {
    async render(element, nonce, handlers) {
      google = await loadGoogleIdentity();
      google.initialize({
        client_id: clientId,
        auto_select: false,
        nonce,
        callback: ({ credential }) => {
          stopWatching?.();
          handlers.onIdToken(credential);
        },
      });
      google.renderButton(element, {
        theme: 'outline',
        size: 'large',
        ...buttonOptions,
        click_listener: () => {
          stopWatching?.();
          stopWatching = watchForCancel(handlers.onCanceled);
        },
      });
    },
    signOut() {
      stopWatching?.();
      google?.disableAutoSelect();
    },
  };
}

/**
 * Google's button reports no cancellation. Its popup takes focus and gives it back when it closes,
 * so a return of focus with no credential after a short wait means the customer closed it.
 */
function watchForCancel(onCanceled: () => void): () => void {
  let timer: number | undefined;
  const onFocus = () => {
    timer = window.setTimeout(() => {
      stop();
      onCanceled();
    }, CANCEL_GRACE_MS);
  };
  const onBlur = () => {
    window.clearTimeout(timer);
    window.addEventListener('focus', onFocus, { once: true });
  };
  const stop = () => {
    window.clearTimeout(timer);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('focus', onFocus);
  };
  window.addEventListener('blur', onBlur);
  return stop;
}
