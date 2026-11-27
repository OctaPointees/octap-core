import { beforeEach, describe, expect, it, vi } from 'vitest';

type EncryptInput = { id: string; packageId: string; threshold: number; data: Uint8Array };
const encrypt = vi.fn<(input: EncryptInput) => Promise<{ encryptedObject: Uint8Array }>>(async () => ({
  encryptedObject: new Uint8Array([9, 9, 9]),
}));
vi.mock('@mysten/seal', () => ({
  SealClient: class {
    encrypt = encrypt;
  },
}));

const { WalrusConsoleClient } = await import('#infra/clients/walrus/walrus-console.client.js');

const BUCKET = '11111111-2222-4333-8444-555555555555';
const POLICY = '0x' + 'ab'.repeat(32);

type Route = { status?: number; body: unknown };

/** Answers Console API calls by path, and records them. */
function stubConsole(routes: Record<string, Route | (() => Route)>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const path = new URL(url).pathname;
      const route = routes[`${init?.method ?? 'GET'} ${path}`];
      if (!route) return new Response('not found', { status: 404 });
      const { status = 200, body } = typeof route === 'function' ? route() : route;
      return new Response(JSON.stringify(body), { status });
    }),
  );
  return calls;
}

function configured() {
  vi.stubEnv('WALRUS_CONSOLE_API_KEY', 'hbr_test');
  vi.stubEnv('WALRUS_CONSOLE_BUCKET_ID', BUCKET);
  return new WalrusConsoleClient();
}

describe('WalrusConsoleClient', () => {
  beforeEach(() => encrypt.mockClear());

  it('is off until both the API key and the folder are set', async () => {
    vi.stubEnv('WALRUS_CONSOLE_API_KEY', ' ');
    vi.stubEnv('WALRUS_CONSOLE_BUCKET_ID', BUCKET);
    const client = new WalrusConsoleClient();
    expect(client.enabled).toBe(false);
    await expect(client.upload('x', new Uint8Array())).rejects.toThrow(/not configured/);
    vi.stubEnv('WALRUS_CONSOLE_API_KEY', 'hbr_test');
    expect(client.enabled).toBe(true);
  });

  it('encrypts for the folder policy, then uploads the ciphertext only', async () => {
    const calls = stubConsole({
      [`GET /api/v1/buckets/${BUCKET}/policy`]: { body: { data: { state: 'resolvable', seal_policy_id: POLICY } } },
      [`POST /api/v1/buckets/${BUCKET}/files`]: { status: 202, body: { data: { id: 'file-1' } } },
    });
    const client = configured();
    await expect(client.upload('bundle.json', new TextEncoder().encode('{"a":1}'))).resolves.toBe('file-1');
    await client.upload('again.json', new Uint8Array([1]));

    // The policy is read once; Seal's identity starts with it and the default network is mainnet.
    expect(calls.filter((c) => c.url.endsWith('/policy'))).toHaveLength(1);
    expect(calls[0].url).toBe(`https://api.console.walrus.xyz/api/v1/buckets/${BUCKET}/policy`);
    expect(calls[0].init?.headers).toMatchObject({ Authorization: 'Bearer hbr_test' });
    const [{ id, packageId, threshold, data }] = encrypt.mock.calls[0];
    expect(id.startsWith(POLICY.slice(2))).toBe(true);
    expect(id).toHaveLength(128);
    expect(packageId).toBe('0xb8d5b1cade7917190c47b8abfc789f527389fc021a8963c22755bcc1b539786c');
    expect(threshold).toBe(1);
    expect(new TextDecoder().decode(data)).toBe('{"a":1}');
    const form = calls[1].init?.body as FormData;
    expect(form.get('name')).toBe('bundle.json');
    expect(new Uint8Array(await (form.get('file') as Blob).arrayBuffer())).toEqual(new Uint8Array([9, 9, 9]));
  });

  it('targets the testnet Console when asked', async () => {
    vi.stubEnv('WALRUS_CONSOLE_NETWORK', 'testnet');
    const calls = stubConsole({
      [`GET /api/v1/buckets/${BUCKET}/policy`]: { body: { data: { state: 'resolvable', seal_policy_id: POLICY } } },
      [`POST /api/v1/buckets/${BUCKET}/files`]: { status: 202, body: { data: { id: 'file-1' } } },
    });
    await configured().upload('b.json', new Uint8Array([1]));
    expect(calls[0].url.startsWith('https://api.beta.testnet.console.walrus.xyz/')).toBe(true);
    expect(encrypt.mock.calls[0][0].packageId).toBe(
      '0xf9b261d4c0dbcf845d79f864e85581f9686fd6de9f4770ba1d77489d67f7833c',
    );
  });

  it('refuses to upload while the folder policy is not resolvable', async () => {
    stubConsole({
      [`GET /api/v1/buckets/${BUCKET}/policy`]: {
        body: { data: { state: 'missing', seal_policy_id: null, reason: 'policy_missing' } },
      },
    });
    await expect(configured().upload('b.json', new Uint8Array([1]))).rejects.toThrow(
      /not ready for uploads \(policy missing: policy_missing\)/,
    );
    stubConsole({
      [`GET /api/v1/buckets/${BUCKET}/policy`]: { body: { data: { state: 'pending', seal_policy_id: null } } },
    });
    await expect(configured().upload('b.json', new Uint8Array([1]))).rejects.toThrow(/policy pending\)/);
    expect(encrypt).not.toHaveBeenCalled();
  });

  it('reports a Console error with its status', async () => {
    stubConsole({ [`GET /api/v1/buckets/${BUCKET}/policy`]: { status: 403, body: { code: 'mirror_missing_grant' } } });
    await expect(configured().upload('b.json', new Uint8Array([1]))).rejects.toThrow(
      /GET \/api\/v1\/buckets\/.+\/policy answered 403: .*mirror_missing_grant/,
    );
  });

  describe('fileState', () => {
    const file = `/api/v1/buckets/${BUCKET}/files/file-1`;

    it('is completed once the file record has a blob id', async () => {
      stubConsole({ [`GET ${file}`]: { body: { data: { blob_id: 'blob-1' } } } });
      await expect(configured().fileState('file-1')).resolves.toEqual({ state: 'completed', blobId: 'blob-1' });
    });

    it('is still uploading while the job runs, or once the job has left the queue', async () => {
      stubConsole({
        [`GET ${file}`]: { body: { data: { blob_id: null } } },
        [`GET ${file}/status`]: { body: { data: { state: 'active' } } },
      });
      await expect(configured().fileState('file-1')).resolves.toEqual({ state: 'uploading' });
      stubConsole({ [`GET ${file}`]: { body: { data: { blob_id: null } } } });
      await expect(configured().fileState('file-1')).resolves.toEqual({ state: 'uploading' });
    });

    it('is failed when the upload job failed', async () => {
      stubConsole({
        [`GET ${file}`]: { body: { data: { blob_id: null } } },
        [`GET ${file}/status`]: { body: { data: { state: 'failed', error: { code: 'walrus', message: 'down' } } } },
      });
      await expect(configured().fileState('file-1')).resolves.toEqual({ state: 'failed', error: 'walrus: down' });
      stubConsole({
        [`GET ${file}`]: { body: { data: { blob_id: null } } },
        [`GET ${file}/status`]: { body: { data: { state: 'failed' } } },
      });
      await expect(configured().fileState('file-1')).resolves.toEqual({ state: 'failed', error: 'failed' });
    });
  });
});
