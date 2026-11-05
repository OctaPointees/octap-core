import { SIGNATURE_SCHEME_TO_FLAG } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64, toBase64 } from '@mysten/sui/utils';
import { verifyTransactionSignature } from '@mysten/sui/verify';
import { parseZkLoginSignature } from '@mysten/sui/zklogin';
import type { ClaimVoucherResponse, FinalizePosRedemptionResponse } from '@octap/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OctapAuthError, createOctapAuth, type FinalizedClaim, type SignableClaim } from '../src/index.js';

// The SDK declares its own types so it can publish alone; these keep them honest against Core's.
const _claimFits = (claim: ClaimVoucherResponse): SignableClaim => claim;
const _finalizeFits = (response: FinalizePosRedemptionResponse): FinalizedClaim => response;
void _claimFits;
void _finalizeFits;

const ORG = 'org-1';
const NONCE = 'nonce-1';
const STORAGE_KEY = `octap.auth.${JSON.stringify(['https://core.test', 'google-client', ORG])}`;
const PROOF = {
  proofPoints: { a: ['1', '2', '3'], b: [['1', '2'], ['3', '4'], ['5', '6']], c: ['1', '2', '3'] }, // prettier-ignore
  issBase64Details: { value: 'wiaXNzIjoiaHR0cHM6Ly9hY2NvdW50cy5nb29nbGUuY29tIiw', indexMod4: 1 },
  headerBase64: 'eyJhbGciOiJSUzI1NiJ9',
  addressSeed: '123456789',
};

function jwt(payload: Record<string, unknown>) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256' })}.${encode(payload)}.sig`;
}
const validToken = (overrides: Record<string, unknown> = {}) =>
  jwt({ nonce: NONCE, exp: Math.floor(Date.now() / 1000) + 3600, ...overrides });

const CUSTOMER_ADDRESS = Ed25519Keypair.generate().getPublicKey().toSuiAddress();

/** Sponsored-shaped transaction bytes, built offline with every field a client would have looked up. */
async function transactionBytes(sender = CUSTOMER_ADDRESS) {
  const tx = new Transaction();
  tx.setSender(sender);
  tx.setGasOwner(Ed25519Keypair.generate().getPublicKey().toSuiAddress());
  tx.setGasPrice(1000);
  tx.setGasBudget(10_000_000);
  tx.setGasPayment([
    { objectId: '0x'.padEnd(66, 'a'), version: 1, digest: 'CUvFvvP4PJ1LXkCBDdxQdHsPa4dPTAvX4NLFBkNGMPGs' },
  ]);
  return toBase64(await tx.build());
}

interface CoreCall {
  path: string;
  body: Record<string, unknown>;
}

/** A Core double answering with real `Response` objects, so body handling is exercised for real. */
function fakeCore(overrides: Record<string, () => Response | Promise<Response>> = {}) {
  const calls: CoreCall[] = [];
  const routes: Record<string, () => Response | Promise<Response>> = {
    '/v1/identity/zklogin/nonce': () =>
      Response.json({
        nonce: NONCE,
        randomness: 'r',
        epoch: 1,
        maxEpoch: 5,
        estimatedExpiration: Date.now() + 86_400_000,
      }),
    '/v1/identity/google-login': () =>
      Response.json({ endUserId: 'eu-1', suiAddress: CUSTOMER_ADDRESS, isNewUser: true }),
    [`/v1/identity/organizations/${ORG}/enroll`]: () =>
      Response.json({ organizationEndUserId: 'member-1', endUserId: 'eu-1', isNewEnrollment: true }),
    '/v1/identity/zklogin/proof': () => Response.json(PROOF),
    '/v1/rewards/vouchers/use/finalize': () =>
      Response.json({ voucherOwnershipId: 'own-1', status: 'REDEEMED', blockchainDigest: 'DIGEST' }),
    '/v1/credits/redeem/finalize': () =>
      Response.json({
        transactionId: 'tx-1',
        organizationEndUserId: 'member-1',
        pointsRedeemed: 25,
        newBalance: 75,
        status: 'CONFIRMED',
        blockchainDigest: 'DIGEST',
      }),
    ...overrides,
  };
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace('https://core.test', '');
    calls.push({ path, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const route = routes[path];
    if (!route) throw new Error(`Unexpected request to ${path}`);
    return route();
  });
  return { calls, fetch: fetchFn as unknown as typeof fetch };
}

/** Google's script, with the callback and click listener exposed for the test to drive. */
function installGoogle() {
  const google = {
    callback: undefined as undefined | ((response: { credential: string }) => void),
    click: undefined as undefined | (() => void),
    nonces: [] as string[],
    disableAutoSelect: vi.fn(),
    initialize(options: { callback: (response: { credential: string }) => void; nonce: string }) {
      google.callback = options.callback;
      google.nonces.push(options.nonce);
    },
    renderButton: vi.fn((_element: unknown, options: { click_listener: () => void }) => {
      google.click = options.click_listener;
    }),
  };
  const win = {
    google: { accounts: { id: google } },
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (timer: number) => clearTimeout(timer),
    setInterval: (...args: Parameters<typeof setInterval>) => setInterval(...args),
    clearInterval: (timer: number) => clearInterval(timer),
  };
  const focus = { value: true };
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', { hasFocus: () => focus.value });
  return { google, win, focus };
}

function installSessionStorage() {
  const data = new Map<string, string>();
  const storage = {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
  vi.stubGlobal('sessionStorage', storage);
  return storage;
}

const element = { replaceChildren: vi.fn() } as unknown as HTMLElement;
const authWith = (core: ReturnType<typeof fakeCore>, persistence?: 'session' | 'memory') =>
  createOctapAuth({
    apiBaseUrl: 'https://core.test/',
    organizationId: ORG,
    googleClientId: 'google-client',
    fetch: core.fetch,
    persistence,
  });

/** Runs the whole sign-in and waits until the auth state reports it. */
async function signIn(auth: ReturnType<typeof authWith>, google: ReturnType<typeof installGoogle>['google']) {
  await auth.renderGoogleButton(element);
  const signedIn = new Promise<void>((resolve) => {
    const stop = auth.onAuthStateChanged((user) => {
      if (user) {
        stop();
        resolve();
      }
    });
  });
  google.callback!({ credential: validToken() });
  await signedIn;
}

const errorFrom = (promise: Promise<unknown>) =>
  promise.then(
    () => expect.fail('expected a rejection'),
    (err: unknown) => err as OctapAuthError,
  );

describe('sign-in', () => {
  let google: ReturnType<typeof installGoogle>['google'];

  beforeEach(() => {
    google = installGoogle().google;
    installSessionStorage();
  });

  it('runs nonce, login, enroll and proof, and sends only the public half of the key', async () => {
    const core = fakeCore();
    const auth = authWith(core);

    await signIn(auth, google);

    expect(auth.currentUser).toEqual({ endUserId: 'eu-1', memberId: 'member-1', suiAddress: CUSTOMER_ADDRESS });
    expect(element.replaceChildren).toHaveBeenCalled();
    expect(core.calls.map((call) => call.path)).toEqual([
      '/v1/identity/zklogin/nonce',
      '/v1/identity/google-login',
      `/v1/identity/organizations/${ORG}/enroll`,
      '/v1/identity/zklogin/proof',
    ]);
    expect(google.nonces).toEqual([NONCE]);
    const session = JSON.parse(
      [...(globalThis.sessionStorage as unknown as { data: Map<string, string> }).data.values()][0],
    ) as {
      signer: { secretKey: string };
    };
    expect(session.signer.secretKey).toMatch(/^suiprivkey/);
    expect(JSON.stringify(core.calls)).not.toContain(session.signer.secretKey);
  });

  it('notifies listeners with the current state, then on each change, until unsubscribed', async () => {
    const auth = authWith(fakeCore());
    const seen: unknown[] = [];
    const stop = auth.onAuthStateChanged((user) => seen.push(user?.memberId ?? null));
    await Promise.resolve();
    expect(seen).toEqual([null]);

    await signIn(auth, google);
    expect(seen).toEqual([null, 'member-1']);
    await auth.signOut();
    expect(seen).toEqual([null, 'member-1', null]);

    stop();
    await signIn(auth, google);
    expect(seen).toHaveLength(3);
  });

  it('does not call a listener removed before its first notification', async () => {
    const auth = authWith(fakeCore());
    const listener = vi.fn();
    auth.onAuthStateChanged(listener)();
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
  });

  it('reports a token issued for another nonce, skips the backend, and re-arms the button', async () => {
    const core = fakeCore();
    const auth = authWith(core);
    const errors: OctapAuthError[] = [];
    await auth.renderGoogleButton(element, { onError: (err) => errors.push(err) });

    google.callback!({ credential: validToken({ nonce: 'someone-elses' }) });
    await vi.waitFor(() => expect(google.nonces).toHaveLength(2));

    expect(errors[0].code).toBe('nonce-mismatch');
    expect(core.calls.map((call) => call.path)).not.toContain('/v1/identity/google-login');
    expect(auth.currentUser).toBeNull();
  });

  it('reports an unreadable token as a nonce mismatch', async () => {
    const auth = authWith(fakeCore());
    const errors: OctapAuthError[] = [];
    await auth.renderGoogleButton(element, { onError: (err) => errors.push(err) });

    google.callback!({ credential: 'not-a-jwt' });

    await vi.waitFor(() => expect(errors[0]?.code).toBe('nonce-mismatch'));
  });

  it('reports an expired sign-in attempt', async () => {
    const core = fakeCore({
      '/v1/identity/zklogin/nonce': () =>
        Response.json({ nonce: NONCE, randomness: 'r', maxEpoch: 5, estimatedExpiration: Date.now() - 1 }),
    });
    const auth = authWith(core);
    const errors: OctapAuthError[] = [];
    await auth.renderGoogleButton(element, { onError: (err) => errors.push(err) });

    google.callback!({ credential: validToken() });

    await vi.waitFor(() => expect(errors[0]?.code).toBe('session-expired'));
  });

  it('reports a failure from Core and leaves a usable button', async () => {
    const core = fakeCore({
      [`/v1/identity/organizations/${ORG}/enroll`]: () =>
        Response.json({ message: 'Not accepting members' }, { status: 409 }),
    });
    const auth = authWith(core);
    const errors: OctapAuthError[] = [];
    await auth.renderGoogleButton(element, { onError: (err) => errors.push(err) });

    google.callback!({ credential: validToken() });
    await vi.waitFor(() => expect(google.nonces).toHaveLength(2));

    expect(errors[0]).toMatchObject({ code: 'api-error', status: 409, message: 'Not accepting members' });
    expect(auth.currentUser).toBeNull();
  });

  it.each([
    ['a proof with missing fields', { '/v1/identity/zklogin/proof': () => Response.json({ proofPoints: {} }) }],
    ['a login without an address', { '/v1/identity/google-login': () => Response.json({ endUserId: 'eu-1' }) }],
    [
      'an enrollment without a member',
      { [`/v1/identity/organizations/${ORG}/enroll`]: () => Response.json({ endUserId: 'eu-1' }) },
    ],
  ])('refuses %s instead of a session that cannot sign', async (_name, overrides) => {
    const auth = authWith(fakeCore(overrides));
    const errors: OctapAuthError[] = [];
    await auth.renderGoogleButton(element, { onError: (err) => errors.push(err) });

    google.callback!({ credential: validToken() });

    await vi.waitFor(() => expect(errors[0]?.code).toBe('invalid-response'));
    expect(auth.currentUser).toBeNull();
  });

  it('reports when the button cannot be re-armed after a failure', async () => {
    let nonceCalls = 0;
    const core = fakeCore({
      '/v1/identity/zklogin/nonce': () =>
        ++nonceCalls === 1
          ? Response.json({ nonce: NONCE, randomness: 'r', maxEpoch: 5, estimatedExpiration: Date.now() + 1000 })
          : new Response('bad gateway', { status: 502 }),
      '/v1/identity/google-login': () => new Response('bad gateway', { status: 502 }),
    });
    const auth = authWith(core);
    const errors: OctapAuthError[] = [];
    await auth.renderGoogleButton(element, { onError: (err) => errors.push(err) });

    google.callback!({ credential: validToken() });

    await vi.waitFor(() => expect(errors).toHaveLength(2));
  });

  it('ignores a second credential while one sign-in is running', async () => {
    let finishLogin: (response: Response) => void = () => {};
    const core = fakeCore({
      '/v1/identity/google-login': () => new Promise<Response>((resolve) => (finishLogin = resolve)),
    });
    const auth = authWith(core);
    await auth.renderGoogleButton(element);

    google.callback!({ credential: validToken() });
    google.callback!({ credential: validToken() });
    await vi.waitFor(() => expect(core.calls.filter((call) => call.path.endsWith('google-login'))).toHaveLength(1));
    finishLogin(Response.json({ endUserId: 'eu-1', suiAddress: CUSTOMER_ADDRESS }));

    await vi.waitFor(() => expect(auth.currentUser).not.toBeNull());
    expect(core.calls.filter((call) => call.path.endsWith('google-login'))).toHaveLength(1);
  });

  it('wraps an unexpected failure in a typed error', async () => {
    const auth = authWith(fakeCore());
    const errors: OctapAuthError[] = [];
    await auth.renderGoogleButton(element, { onError: (err) => errors.push(err) });
    google.renderButton.mockImplementationOnce(() => {
      throw new Error('boom');
    });

    google.callback!({ credential: validToken({ nonce: 'wrong' }) });

    await vi.waitFor(() => expect(errors).toHaveLength(2));
    expect(errors[1]).toBeInstanceOf(OctapAuthError);
    expect(errors[1]).toMatchObject({ code: 'provider-unavailable', message: 'boom' });
  });
});

describe('signing out during a sign-in', () => {
  let google: ReturnType<typeof installGoogle>['google'];
  let storage: ReturnType<typeof installSessionStorage>;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  beforeEach(() => {
    google = installGoogle().google;
    storage = installSessionStorage();
  });

  /** Signs in until Core's proof is requested, and holds that response. */
  async function heldAtProof(proofs: Array<() => Promise<Response>> = []) {
    let settleProof: { resolve: (response: Response) => void; reject: (err: Error) => void } | undefined;
    const held = () =>
      new Promise<Response>((resolve, reject) => {
        settleProof = { resolve, reject };
      });
    const queue = [held, ...proofs];
    const core = fakeCore({ '/v1/identity/zklogin/proof': () => queue.shift()!() });
    const auth = authWith(core);
    const errors: OctapAuthError[] = [];
    const seen: unknown[] = [];
    auth.onAuthStateChanged((user) => seen.push(user?.memberId ?? null));
    await auth.renderGoogleButton(element, { onError: (err) => errors.push(err) });
    google.callback!({ credential: validToken() });
    await vi.waitFor(() => expect(core.calls.some((call) => call.path.endsWith('proof'))).toBe(true));
    return { auth, core, errors, seen, proof: () => settleProof! };
  }

  it('keeps the customer signed out when the proof arrives afterwards', async () => {
    const { auth, seen, proof } = await heldAtProof();

    await auth.signOut();
    proof().resolve(Response.json(PROOF));
    await settle();

    expect(auth.currentUser).toBeNull();
    expect(storage.data.size).toBe(0);
    expect(seen).not.toContain('member-1');
  });

  it('stops a sign-in that is still at an earlier step', async () => {
    let finishLogin: (response: Response) => void = () => {};
    const core = fakeCore({
      '/v1/identity/google-login': () => new Promise<Response>((resolve) => (finishLogin = resolve)),
    });
    const auth = authWith(core);
    await auth.renderGoogleButton(element);
    google.callback!({ credential: validToken() });
    await vi.waitFor(() => expect(core.calls.some((call) => call.path.endsWith('google-login'))).toBe(true));

    await auth.signOut();
    finishLogin(Response.json({ endUserId: 'eu-1', suiAddress: CUSTOMER_ADDRESS }));
    await settle();

    expect(core.calls.some((call) => call.path.endsWith('enroll'))).toBe(false);
    expect(auth.currentUser).toBeNull();
  });

  it('stops after enrollment too', async () => {
    let finishEnroll: (response: Response) => void = () => {};
    const core = fakeCore({
      [`/v1/identity/organizations/${ORG}/enroll`]: () => new Promise<Response>((resolve) => (finishEnroll = resolve)),
    });
    const auth = authWith(core);
    await auth.renderGoogleButton(element);
    google.callback!({ credential: validToken() });
    await vi.waitFor(() => expect(core.calls.some((call) => call.path.endsWith('enroll'))).toBe(true));

    await auth.signOut();
    finishEnroll(Response.json({ organizationEndUserId: 'member-1', endUserId: 'eu-1' }));
    await settle();

    expect(core.calls.some((call) => call.path.endsWith('proof'))).toBe(false);
  });

  it('reports nothing and re-arms nothing when the abandoned sign-in fails', async () => {
    const { auth, errors, proof } = await heldAtProof();
    await auth.signOut();
    const nonces = google.nonces.length;

    proof().reject(new TypeError('fetch failed'));
    await settle();

    expect(errors).toEqual([]);
    expect(google.nonces).toHaveLength(nonces);
  });

  it('lets a new sign-in run, and the abandoned one cannot replace it', async () => {
    const { auth, core, proof } = await heldAtProof([async () => Response.json(PROOF)]);
    const abandoned = proof();
    await auth.signOut();

    google.callback!({ credential: validToken({ sub: 'second' }) });
    await vi.waitFor(() => expect(auth.currentUser).not.toBeNull());
    const session = storage.data.get(STORAGE_KEY);
    expect(core.calls.filter((call) => call.path.endsWith('google-login'))).toHaveLength(2);

    abandoned.resolve(Response.json(PROOF));
    await settle();

    expect(storage.data.get(STORAGE_KEY)).toBe(session);
    expect(auth.currentUser?.memberId).toBe('member-1');
  });

  it('renders only the latest nonce when buttons are armed in quick succession', async () => {
    const responses: Array<(response: Response) => void> = [];
    let calls = 0;
    const core = fakeCore({
      '/v1/identity/zklogin/nonce': () =>
        ++calls === 1
          ? Response.json({ nonce: NONCE, randomness: 'r', maxEpoch: 5, estimatedExpiration: Date.now() + 86_400_000 })
          : new Promise<Response>((resolve) => responses.push(resolve)),
    });
    const auth = authWith(core);
    await auth.renderGoogleButton(element);
    const first = auth.signOut();
    const second = auth.signOut();
    await vi.waitFor(() => expect(responses).toHaveLength(2));
    const nonce = (value: string) =>
      Response.json({ nonce: value, randomness: 'r', maxEpoch: 5, estimatedExpiration: Date.now() + 86_400_000 });

    responses[1](nonce('newest'));
    await second;
    responses[0](nonce('older'));
    await first;

    expect(google.nonces.at(-1)).toBe('newest');
    expect(google.nonces).not.toContain('older');
  });

  it('ignores a credential from a button that was replaced', async () => {
    const auth = authWith(fakeCore());
    const errors: OctapAuthError[] = [];
    await auth.renderGoogleButton(element, { onError: (err) => errors.push(err) });
    const replaced = google.callback!;

    await auth.signOut();
    replaced({ credential: validToken() });
    await settle();

    expect(auth.currentUser).toBeNull();
    expect(errors).toEqual([]);
  });
});

describe('canceled sign-in', () => {
  /** Clicks the button with fake timers running, returning controls for the popup's focus. */
  async function clickedButton() {
    const { google, focus } = installGoogle();
    installSessionStorage();
    const auth = authWith(fakeCore());
    const errors: OctapAuthError[] = [];
    await auth.renderGoogleButton(element, { onError: (err) => errors.push(err) });
    google.click!();
    return { google, focus, errors };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports a cancellation when focus returns with no credential', async () => {
    const { focus, errors } = await clickedButton();

    focus.value = false;
    vi.advanceTimersByTime(500);
    expect(errors).toEqual([]);
    focus.value = true;
    vi.advanceTimersByTime(2_000);

    expect(errors.map((err) => err.code)).toEqual(['sign-in-canceled']);
    vi.advanceTimersByTime(10_000);
    expect(errors).toHaveLength(1);
  });

  it('stays quiet when the credential arrives in the grace period', async () => {
    const { google, focus, errors } = await clickedButton();

    focus.value = false;
    vi.advanceTimersByTime(500);
    focus.value = true;
    vi.advanceTimersByTime(500);
    google.callback!({ credential: validToken() });
    vi.advanceTimersByTime(5_000);

    expect(errors).toEqual([]);
  });

  it('never reports while focus has not left the page', async () => {
    const { errors } = await clickedButton();
    vi.advanceTimersByTime(60_000);
    expect(errors).toEqual([]);
  });

  it('restarts the wait if the popup takes focus again, and gives up on a popup left open', async () => {
    const { focus, errors } = await clickedButton();

    focus.value = false;
    vi.advanceTimersByTime(500);
    focus.value = true;
    vi.advanceTimersByTime(500);
    focus.value = false;
    vi.advanceTimersByTime(6 * 60_000);
    focus.value = true;
    vi.advanceTimersByTime(5_000);

    expect(errors).toEqual([]);
  });
});

describe('Google script loading', () => {
  it('needs a browser', async () => {
    vi.stubGlobal('window', undefined);
    const auth = authWith(fakeCore(), 'memory');
    await expect(errorFrom(auth.renderGoogleButton(element))).resolves.toMatchObject({ code: 'provider-unavailable' });
  });

  it('loads the script once, and retries after it fails', async () => {
    const scripts: Array<{ src: string; onload?: () => void; onerror?: () => void; remove: () => void }> = [];
    const win: Record<string, unknown> = { setTimeout, clearTimeout };
    vi.stubGlobal('window', win);
    vi.stubGlobal('document', {
      createElement: () => ({ remove: vi.fn() }),
      head: { appendChild: (script: (typeof scripts)[number]) => scripts.push(script) },
    });
    const auth = authWith(fakeCore(), 'memory');

    const failing = auth.renderGoogleButton(element);
    await vi.waitFor(() => expect(scripts).toHaveLength(1));
    expect(scripts[0].src).toBe('https://accounts.google.com/gsi/client');
    scripts[0].onerror!();
    await expect(errorFrom(failing)).resolves.toMatchObject({ code: 'provider-unavailable' });

    const emptyLoad = auth.renderGoogleButton(element);
    await vi.waitFor(() => expect(scripts).toHaveLength(2));
    scripts[1].onload!();
    await expect(errorFrom(emptyLoad)).resolves.toMatchObject({ code: 'provider-unavailable' });

    const working = auth.renderGoogleButton(element);
    const second = auth.renderGoogleButton(element);
    await vi.waitFor(() => expect(scripts).toHaveLength(3));
    await new Promise((resolve) => setTimeout(resolve));
    expect(scripts).toHaveLength(3);
    const google = { initialize: vi.fn(), renderButton: vi.fn(), disableAutoSelect: vi.fn() };
    win.google = { accounts: { id: google } };
    scripts[2].onload!();
    await Promise.all([working, second]);
    expect(google.renderButton).toHaveBeenCalled();
  });
});

describe('session', () => {
  let google: ReturnType<typeof installGoogle>['google'];
  let storage: ReturnType<typeof installSessionStorage>;

  beforeEach(() => {
    google = installGoogle().google;
    storage = installSessionStorage();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('restores across a reload, and asks for no new nonce while signed in', async () => {
    await signIn(authWith(fakeCore()), google);

    const core = fakeCore();
    const reloaded = authWith(core);
    await reloaded.renderGoogleButton(element);

    expect(reloaded.currentUser?.memberId).toBe('member-1');
    expect(await reloaded.getIdToken()).toMatch(/\./);
    expect(core.calls).toEqual([]);
  });

  it.each([
    ['API URL', { apiBaseUrl: 'https://another.test' }],
    ['Google client ID', { googleClientId: 'another-client' }],
    ['organization', { organizationId: 'org-2' }],
  ])('does not restore a session under another %s', async (_name, change) => {
    await signIn(authWith(fakeCore()), google);

    const other = createOctapAuth({
      apiBaseUrl: 'https://core.test',
      organizationId: ORG,
      googleClientId: 'google-client',
      fetch: fakeCore().fetch,
      ...change,
    });

    expect(other.currentUser).toBeNull();
  });

  it('restores the same configuration, however its URL ends', async () => {
    await signIn(authWith(fakeCore()), google);

    const same = createOctapAuth({
      apiBaseUrl: 'https://core.test//',
      organizationId: ORG,
      googleClientId: 'google-client',
      fetch: fakeCore().fetch,
    });

    expect(same.currentUser?.memberId).toBe('member-1');
  });

  it('keeps an isolated session per organization', async () => {
    await signIn(authWith(fakeCore()), google);
    const other = createOctapAuth({
      apiBaseUrl: 'https://core.test',
      organizationId: 'org-2',
      googleClientId: 'google-client',
      fetch: fakeCore().fetch,
    });
    expect(other.currentUser).toBeNull();
  });

  it('with memory persistence writes nothing to browser storage and is gone after reload', async () => {
    const auth = authWith(fakeCore(), 'memory');
    await signIn(auth, google);

    expect(auth.currentUser).not.toBeNull();
    expect(storage.data.size).toBe(0);
    expect(authWith(fakeCore(), 'memory').currentUser).toBeNull();
  });

  it('signs out, clearing storage and issuing a fresh nonce', async () => {
    const auth = authWith(fakeCore());
    await signIn(auth, google);

    await auth.signOut();

    expect(auth.currentUser).toBeNull();
    expect(storage.data.size).toBe(0);
    expect(google.disableAutoSelect).toHaveBeenCalled();
    expect(google.nonces).toHaveLength(2);
    await expect(errorFrom(auth.getIdToken())).resolves.toMatchObject({ code: 'not-signed-in' });
  });

  it('signs out cleanly when no button was rendered', async () => {
    const auth = authWith(fakeCore());
    await auth.signOut();
    expect(auth.currentUser).toBeNull();
  });

  it('drops a stored session past maxEpoch on load', async () => {
    await signIn(authWith(fakeCore()), google);
    vi.useFakeTimers({ now: Date.now() + 2 * 86_400_000 });

    expect(authWith(fakeCore()).currentUser).toBeNull();
    expect(storage.data.size).toBe(0);
  });

  it('expires a live session past maxEpoch with a typed error and a new button', async () => {
    const auth = authWith(fakeCore());
    await signIn(auth, google);
    const seen: unknown[] = [];
    auth.onAuthStateChanged((user) => seen.push(user));
    await Promise.resolve();
    seen.length = 0;
    const bytes = await transactionBytes();
    vi.useFakeTimers({ now: Date.now() + 2 * 86_400_000, toFake: ['Date'] });

    await expect(errorFrom(auth.signTransaction(bytes))).resolves.toMatchObject({ code: 'session-expired' });

    expect(auth.currentUser).toBeNull();
    expect(seen).toEqual([null]);
    await vi.waitFor(() => expect(google.nonces).toHaveLength(2));
  });

  it('reports when the button cannot return after a session expires', async () => {
    let nonceCalls = 0;
    const core = fakeCore({
      '/v1/identity/zklogin/nonce': () =>
        ++nonceCalls === 1
          ? Response.json({ nonce: NONCE, randomness: 'r', maxEpoch: 5, estimatedExpiration: Date.now() + 86_400_000 })
          : new Response('bad gateway', { status: 502 }),
    });
    const auth = authWith(core);
    const errors: OctapAuthError[] = [];
    await auth.renderGoogleButton(element, { onError: (err) => errors.push(err) });
    google.callback!({ credential: validToken() });
    await vi.waitFor(() => expect(auth.currentUser).not.toBeNull());
    const bytes = await transactionBytes();
    vi.useFakeTimers({ now: Date.now() + 2 * 86_400_000, toFake: ['Date'] });

    await errorFrom(auth.signTransaction(bytes));

    await vi.waitFor(() => expect(errors[0]?.code).toBe('api-error'));
  });

  it('signs out on an expired id_token, so the button returns for a new one', async () => {
    const auth = authWith(fakeCore());
    await auth.renderGoogleButton(element);
    google.callback!({ credential: validToken({ exp: 1 }) });
    await vi.waitFor(() => expect(auth.currentUser).not.toBeNull());
    const seen: unknown[] = [];
    auth.onAuthStateChanged((user) => seen.push(user));
    await Promise.resolve();
    seen.length = 0;

    await expect(errorFrom(auth.getIdToken())).resolves.toMatchObject({ code: 'token-expired' });

    expect(auth.currentUser).toBeNull();
    expect(seen).toEqual([null]);
    expect(storage.data.size).toBe(0);
    await vi.waitFor(() => expect(google.nonces).toHaveLength(2));
  });

  it('notices maxEpoch passing on an open page, with no call to trip it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const auth = authWith(fakeCore());
    await signIn(auth, google);
    const seen: unknown[] = [];
    auth.onAuthStateChanged((user) => seen.push(user));
    await Promise.resolve();
    seen.length = 0;

    vi.advanceTimersByTime(86_400_000 + 1);

    expect(auth.currentUser).toBeNull();
    expect(seen).toEqual([null]);
    expect(storage.data.size).toBe(0);
    vi.useRealTimers();
    await vi.waitFor(() => expect(google.nonces).toHaveLength(2));
  });

  it('checks again when a long session outlasts the longest browser timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const core = fakeCore({
      '/v1/identity/zklogin/nonce': () =>
        Response.json({
          nonce: NONCE,
          randomness: 'r',
          maxEpoch: 5,
          estimatedExpiration: Date.now() + 30 * 86_400_000,
        }),
    });
    const auth = authWith(core);
    await signIn(auth, google);

    vi.advanceTimersByTime(2_147_483_647);
    expect(auth.currentUser).not.toBeNull();

    vi.advanceTimersByTime(30 * 86_400_000 - 2_147_483_647 + 1);
    expect(auth.currentUser).toBeNull();
  });

  it('reads as signed out, and renders the button, once a stored session has lapsed', async () => {
    const auth = authWith(fakeCore());
    await signIn(auth, google);
    google.nonces.length = 0;
    vi.useFakeTimers({ now: Date.now() + 2 * 86_400_000, toFake: ['Date'] });

    expect(auth.currentUser).toBeNull();
    await auth.renderGoogleButton(element);
    expect(google.nonces).toEqual([NONCE]);
  });

  it('still resolves signOut when the button cannot return, and reports why', async () => {
    let nonceCalls = 0;
    const core = fakeCore({
      '/v1/identity/zklogin/nonce': () =>
        ++nonceCalls === 1
          ? Response.json({ nonce: NONCE, randomness: 'r', maxEpoch: 5, estimatedExpiration: Date.now() + 86_400_000 })
          : Response.json({ message: 'Too many requests' }, { status: 429 }),
    });
    const auth = authWith(core);
    const errors: OctapAuthError[] = [];
    await auth.renderGoogleButton(element, { onError: (err) => errors.push(err) });
    google.callback!({ credential: validToken() });
    await vi.waitFor(() => expect(auth.currentUser).not.toBeNull());

    await expect(auth.signOut()).resolves.toBeUndefined();

    expect(auth.currentUser).toBeNull();
    expect(errors[0]).toMatchObject({ code: 'api-error', status: 429 });
  });

  it('survives a throwing listener: the sign-in stands and other listeners still run', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const auth = authWith(fakeCore());
    const errors: OctapAuthError[] = [];
    const seen: unknown[] = [];
    auth.onAuthStateChanged(() => {
      throw new Error('merchant bug');
    });
    auth.onAuthStateChanged((user) => seen.push(user?.memberId ?? null));
    await auth.renderGoogleButton(element, { onError: (err) => errors.push(err) });

    google.callback!({ credential: validToken() });
    await vi.waitFor(() => expect(auth.currentUser).not.toBeNull());

    expect(seen.at(-1)).toBe('member-1');
    expect(errors).toEqual([]);
    expect(google.nonces).toHaveLength(1);
    expect(log).toHaveBeenCalled();
  });

  it('still re-arms when the onError handler throws', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const auth = authWith(fakeCore());
    await auth.renderGoogleButton(element, {
      onError: () => {
        throw new Error('merchant bug');
      },
    });

    google.callback!({ credential: validToken({ nonce: 'wrong' }) });

    await vi.waitFor(() => expect(google.nonces).toHaveLength(2));
    expect(log).toHaveBeenCalled();
  });

  it('ignores a stored session whose proof is not usable', () => {
    storage.data.set(
      STORAGE_KEY,
      JSON.stringify({
        user: { endUserId: 'e', memberId: 'm', suiAddress: 'a' },
        idToken: 't',
        signer: { secretKey: 's', maxEpoch: 1, expiresAt: Date.now() + 1000, proof: {} },
      }),
    );
    expect(authWith(fakeCore()).currentUser).toBeNull();
  });

  it('gives a typed error, not a raw one, for a corrupted stored key', async () => {
    await signIn(authWith(fakeCore()), google);
    const key = STORAGE_KEY;
    const stored = JSON.parse(storage.data.get(key)!) as { signer: { secretKey: string } };
    stored.signer.secretKey = 'corrupted';
    storage.data.set(key, JSON.stringify(stored));

    const reloaded = authWith(fakeCore());

    await expect(errorFrom(reloaded.signTransaction(await transactionBytes()))).resolves.toMatchObject({
      code: 'session-expired',
    });
  });

  it('returns an id_token whose expiry it cannot read, leaving the backend to judge it', async () => {
    const auth = authWith(fakeCore());
    await auth.renderGoogleButton(element);
    google.callback!({ credential: jwt({ nonce: NONCE }) });
    await vi.waitFor(() => expect(auth.currentUser).not.toBeNull());

    await expect(auth.getIdToken()).resolves.toEqual(expect.any(String));
  });

  it.each([
    ['unparseable', 'not json'],
    ['the wrong shape', JSON.stringify({ user: { endUserId: 'x' } })],
  ])('ignores and removes a stored value that is %s', (_name, value) => {
    storage.data.set(STORAGE_KEY, value);
    const auth = authWith(fakeCore());
    expect(auth.currentUser).toBeNull();
  });

  it('keeps working in memory when browser storage throws', async () => {
    const auth0 = authWith(fakeCore());
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    const auth = authWith(fakeCore());
    await signIn(auth, google);

    expect(auth.currentUser?.memberId).toBe('member-1');
    await auth.signOut();
    expect(auth.currentUser).toBeNull();
    expect(auth0.currentUser).toBeNull();
  });

  it('falls back to memory when browser storage is missing or inaccessible', () => {
    vi.stubGlobal('sessionStorage', undefined);
    expect(authWith(fakeCore()).currentUser).toBeNull();
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('denied');
      },
    });
    try {
      expect(authWith(fakeCore()).currentUser).toBeNull();
    } finally {
      Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: undefined, writable: true });
    }
  });
});

describe('signing', () => {
  let google: ReturnType<typeof installGoogle>['google'];

  beforeEach(() => {
    google = installGoogle().google;
    installSessionStorage();
  });

  it('produces a zkLogin signature whose inner signature verifies over the exact bytes', async () => {
    const core = fakeCore();
    const auth = authWith(core);
    await signIn(auth, google);
    const bytes = await transactionBytes();

    const signature = fromBase64(await auth.signTransaction(bytes));

    expect(signature[0]).toBe(SIGNATURE_SCHEME_TO_FLAG.ZkLogin);
    const parsed = parseZkLoginSignature(signature.slice(1));
    expect(parsed.maxEpoch).toBe('5');
    expect(parsed.inputs.addressSeed).toBe(PROOF.addressSeed);
    const publicKey = await verifyTransactionSignature(fromBase64(bytes), toBase64(parsed.userSignature));
    expect(publicKey.toSuiPublicKey()).toBe(core.calls[0].body.ephemeralPublicKey);
  });

  it('refuses to sign for another account', async () => {
    const auth = authWith(fakeCore());
    await signIn(auth, google);
    const bytes = await transactionBytes(Ed25519Keypair.generate().getPublicKey().toSuiAddress());

    await expect(errorFrom(auth.signTransaction(bytes))).resolves.toMatchObject({ code: 'wrong-account' });
  });

  it('refuses bytes it cannot read', async () => {
    const auth = authWith(fakeCore());
    await signIn(auth, google);
    await expect(errorFrom(auth.signTransaction('AAAA'))).resolves.toMatchObject({ code: 'invalid-claim' });
  });

  it('needs a signed-in customer', async () => {
    const auth = authWith(fakeCore());
    await expect(errorFrom(auth.signTransaction('AAAA'))).resolves.toMatchObject({ code: 'not-signed-in' });
  });
});

describe('signAndFinalize', () => {
  const claim = async () => ({ status: 'RESERVED', digest: 'DIGEST', transactionBytes: await transactionBytes() });
  let google: ReturnType<typeof installGoogle>['google'];

  beforeEach(() => {
    google = installGoogle().google;
    installSessionStorage();
  });

  it('posts the digest and signature, and returns the confirmed result', async () => {
    const core = fakeCore();
    const auth = authWith(core);
    await signIn(auth, google);

    const result = await auth.signAndFinalize(await claim());

    expect(result).toMatchObject({ status: 'CONFIRMED', newBalance: 75, blockchainDigest: 'DIGEST' });
    const finalize = core.calls.at(-1)!;
    expect(finalize.path).toBe('/v1/credits/redeem/finalize');
    expect(finalize.body).toEqual({ digest: 'DIGEST', signature: expect.any(String) });
  });

  it.each([
    ['a free claim', { status: 'AVAILABLE' }],
    ['a claim without bytes', { status: 'RESERVED', digest: 'D' }],
    ['a claim without a digest', { status: 'RESERVED', transactionBytes: 'AAAA' }],
    ['a null digest', { status: 'RESERVED', digest: null, transactionBytes: 'AAAA' }],
  ])('refuses %s', async (_name, invalid) => {
    const auth = authWith(fakeCore());
    await signIn(auth, google);
    await expect(errorFrom(auth.signAndFinalize(invalid))).resolves.toMatchObject({ code: 'invalid-claim' });
  });

  it('passes through a rate limit, the one failure that proves nothing was attempted', async () => {
    const core = fakeCore({
      '/v1/credits/redeem/finalize': () => Response.json({ message: 'Too many requests' }, { status: 429 }),
    });
    const auth = authWith(core);
    await signIn(auth, google);

    await expect(errorFrom(auth.signAndFinalize(await claim()))).resolves.toMatchObject({
      code: 'api-error',
      status: 429,
    });
  });

  it.each([
    ['a 400, which Core also uses for an Enoki failure', () => Response.json({ message: 'Enoki' }, { status: 400 })],
    ['a 404, which a repeat of a finished finalize gets', () => Response.json({ message: 'x' }, { status: 404 })],
    ['a 409, still resolving on-chain', () => Response.json({ message: 'being resolved' }, { status: 409 })],
    ['a 5xx', () => new Response('<html>bad gateway</html>', { status: 502 })],
    ['a dropped connection', () => Promise.reject(new TypeError('fetch failed'))],
    ['an unreadable success', () => new Response('ok', { status: 200 })],
  ])('never retries and reports an unknown outcome on %s', async (_name, respond) => {
    const core = fakeCore({ '/v1/credits/redeem/finalize': respond });
    const auth = authWith(core);
    await signIn(auth, google);

    await expect(errorFrom(auth.signAndFinalize(await claim()))).resolves.toMatchObject({ code: 'outcome-unknown' });
    expect(core.calls.filter((call) => call.path.endsWith('finalize'))).toHaveLength(1);
  });

  it('keeps the long finalize timeout when a caller passes an undefined one', async () => {
    const signals: AbortSignal[] = [];
    const core = fakeCore();
    const fetchFn = core.fetch;
    const auth = createOctapAuth({
      apiBaseUrl: 'https://core.test',
      organizationId: ORG,
      googleClientId: 'google-client',
      timeoutMs: 1,
      fetch: ((url: string, init: RequestInit) => {
        signals.push(init.signal!);
        return fetchFn(url, init);
      }) as typeof fetch,
    });
    const ownClaim = await claim();
    await auth.renderGoogleButton(element);
    google.callback!({ credential: validToken() });
    await vi.waitFor(() => expect(auth.currentUser).not.toBeNull());
    const spy = vi.spyOn(AbortSignal, 'timeout');

    await auth.signAndFinalize(ownClaim, { timeoutMs: undefined });

    expect(spy).toHaveBeenCalledWith(90_000);
  });

  it('reports an unknown outcome when the caller aborts mid-flight', async () => {
    const controller = new AbortController();
    const core = fakeCore({
      '/v1/credits/redeem/finalize': () => {
        controller.abort();
        return Promise.reject(new DOMException('aborted', 'AbortError'));
      },
    });
    const auth = authWith(core);
    await signIn(auth, google);

    await expect(errorFrom(auth.signAndFinalize(await claim(), { signal: controller.signal }))).resolves.toMatchObject({
      code: 'outcome-unknown',
    });
  });
});

describe('signAndFinalizeVoucherUse', () => {
  let google: ReturnType<typeof installGoogle>['google'];

  beforeEach(() => {
    google = installGoogle().google;
    installSessionStorage();
  });

  it('signs the bytes and finalizes through the voucher route', async () => {
    const core = fakeCore();
    const auth = authWith(core);
    await signIn(auth, google);

    await auth.signAndFinalizeVoucherUse({ digest: 'DIGEST', transactionBytes: await transactionBytes() });

    const finalize = core.calls.at(-1)!;
    expect(finalize.path).toBe('/v1/rewards/vouchers/use/finalize');
    expect(finalize.body).toEqual({ digest: 'DIGEST', signature: expect.any(String) });
  });

  it('refuses a use with nothing to sign', async () => {
    const auth = authWith(fakeCore());
    await signIn(auth, google);
    await expect(errorFrom(auth.signAndFinalizeVoucherUse({ digest: null }))).resolves.toMatchObject({
      code: 'invalid-claim',
    });
  });
});

describe('Core errors', () => {
  const nonceRoute = (respond: () => Response | Promise<Response>) =>
    fakeCore({ '/v1/identity/zklogin/nonce': respond });

  beforeEach(() => {
    installGoogle();
    installSessionStorage();
  });

  it('reads a non-JSON error body once, without a TypeError', async () => {
    const auth = authWith(
      nonceRoute(() => new Response('<html>Bad Gateway</html>', { status: 502, statusText: 'Bad Gateway' })),
    );

    const err = await errorFrom(auth.renderGoogleButton(element));

    expect(err).toBeInstanceOf(OctapAuthError);
    expect(err).toMatchObject({
      code: 'api-error',
      status: 502,
      body: '<html>Bad Gateway</html>',
      message: 'OctaP request failed: 502 Bad Gateway',
    });
  });

  it('uses the message from a JSON error body', async () => {
    const auth = authWith(nonceRoute(() => Response.json({ message: 'Too many requests' }, { status: 429 })));
    await expect(errorFrom(auth.renderGoogleButton(element))).resolves.toMatchObject({
      code: 'api-error',
      status: 429,
      message: 'Too many requests',
    });
  });

  it('reports a success it cannot read', async () => {
    const auth = authWith(nonceRoute(() => new Response('ok')));
    await expect(errorFrom(auth.renderGoogleButton(element))).resolves.toMatchObject({ code: 'invalid-response' });
  });

  it('reports a nonce response without a nonce', async () => {
    const auth = authWith(nonceRoute(() => Response.json({ randomness: 'r' })));
    await expect(errorFrom(auth.renderGoogleButton(element))).resolves.toMatchObject({ code: 'invalid-response' });
  });

  it('reports a nonce response without randomness', async () => {
    const auth = authWith(nonceRoute(() => Response.json({ nonce: 'n', maxEpoch: 5, estimatedExpiration: 1 })));
    await expect(errorFrom(auth.renderGoogleButton(element))).resolves.toMatchObject({ code: 'invalid-response' });
  });

  it('reports a network failure', async () => {
    const auth = authWith(nonceRoute(() => Promise.reject(new TypeError('fetch failed'))));
    await expect(errorFrom(auth.renderGoogleButton(element))).resolves.toMatchObject({
      code: 'network-error',
      message: expect.stringContaining('fetch failed'),
    });
  });

  it('reports a timeout', async () => {
    const hanging = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const auth = createOctapAuth({
      apiBaseUrl: 'https://core.test',
      organizationId: ORG,
      googleClientId: 'google-client',
      fetch: hanging as unknown as typeof fetch,
      timeoutMs: 5,
    });
    await expect(errorFrom(auth.renderGoogleButton(element))).resolves.toMatchObject({ code: 'timeout' });
  });

  it('uses the global fetch by default', async () => {
    const core = fakeCore();
    vi.stubGlobal('fetch', core.fetch);
    const auth = createOctapAuth({
      apiBaseUrl: 'https://core.test',
      organizationId: ORG,
      googleClientId: 'google-client',
    });
    await auth.renderGoogleButton(element);
    expect(core.calls[0].path).toBe('/v1/identity/zklogin/nonce');
  });
});

describe('package boundary', () => {
  it('has no Enoki dependency and no credential option', async () => {
    const { readFile } = await import('node:fs/promises');
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies)).toEqual(['@mysten/sui']);
    const source = await readFile(new URL('../src/auth.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/apiKey|authorization/i);
  });
});
