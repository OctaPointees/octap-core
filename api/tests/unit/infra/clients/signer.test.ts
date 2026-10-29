import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { verifyTransactionSignature } from '@mysten/sui/verify';
import {
  ISSUER_SIGNER,
  PROGRAM_ADMIN_SIGNER,
  kmsRegion,
  loadSigner,
  memoizeSigner,
} from '#infra/clients/sui/signer.js';

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const KEY_ARN = 'arn:aws:kms:ap-southeast-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab';
const TX_BYTES = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
const logger = new Logger('signer.test');

type KeySpec = 'ECC_NIST_EDWARDS25519' | 'ECC_SECG_P256K1';
interface KmsCall {
  url: string;
  target: string | null;
  body: { KeyId: string; Message?: string; MessageType?: string; SigningAlgorithm?: string };
}

/** DER `SEQUENCE { INTEGER r, INTEGER s }` <-> bigints, for forcing a high-S signature. */
function derToRS(der: Buffer): [bigint, bigint] {
  let offset = 2;
  const readInt = () => {
    const length = der[offset + 1];
    const value = BigInt(`0x${der.subarray(offset + 2, offset + 2 + length).toString('hex')}`);
    offset += 2 + length;
    return value;
  };
  return [readInt(), readInt()];
}
function rsToDer(r: bigint, s: bigint): Buffer {
  const int = (value: bigint) => {
    let bytes = Buffer.from(value.toString(16).padStart(64, '0'), 'hex');
    while (bytes.length > 1 && bytes[0] === 0 && !(bytes[1] & 0x80)) bytes = bytes.subarray(1);
    if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
    return Buffer.concat([Buffer.from([0x02, bytes.length]), bytes]);
  };
  const body = Buffer.concat([int(r), int(s)]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

/**
 * Stands in for the KMS JSON API behind `fetch`, backed by a node:crypto key with KMS's own
 * semantics: `ED25519_SHA_512` is pure Ed25519 over the raw message, `ECDSA_SHA_256` hashes the
 * raw message with SHA-256 and returns DER — and, like real KMS, may return a high-S signature.
 */
function stubKms(keySpec: KeySpec, options: { highS?: boolean; failFirst?: number } = {}) {
  const { privateKey, publicKey }: { privateKey: KeyObject; publicKey: KeyObject } =
    keySpec === 'ECC_NIST_EDWARDS25519'
      ? generateKeyPairSync('ed25519')
      : generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const calls: KmsCall[] = [];
  let failuresLeft = options.failFirst ?? 0;

  vi.stubGlobal(
    'fetch',
    vi.fn(async (request: Request) => {
      const call: KmsCall = {
        url: request.url,
        target: request.headers.get('x-amz-target'),
        body: (await request.json()) as KmsCall['body'],
      };
      calls.push(call);
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        return Response.json(
          { __type: 'AccessDeniedException', message: 'not authorized to perform kms:GetPublicKey' },
          { status: 400 },
        );
      }
      if (call.target === 'TrentService.GetPublicKey') {
        return Response.json({
          KeyId: KEY_ARN,
          KeySpec: keySpec,
          KeyUsage: 'SIGN_VERIFY',
          PublicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
        });
      }
      const message = Buffer.from(call.body.Message ?? '', 'base64');
      let signature: Buffer =
        keySpec === 'ECC_NIST_EDWARDS25519'
          ? cryptoSign(null, message, privateKey)
          : cryptoSign('sha256', message, { key: privateKey, dsaEncoding: 'der' });
      if (options.highS) {
        const [r, s] = derToRS(signature);
        signature = rsToDer(r, s > SECP256K1_N / 2n ? s : SECP256K1_N - s);
      }
      return Response.json({ KeyId: KEY_ARN, Signature: signature.toString('base64') });
    }),
  );
  return calls;
}

beforeEach(() => {
  // Credentials resolve from env via the default chain; a profile would skip that step.
  vi.stubEnv('AWS_PROFILE', '');
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIAEXAMPLE');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'example-secret');
  vi.stubEnv('AWS_REGION', '');
});

describe('loadSigner via AWS KMS', () => {
  it('signs Sui transactions with an Ed25519 KMS key that Sui verification accepts', async () => {
    const calls = stubKms('ECC_NIST_EDWARDS25519');
    vi.stubEnv('SUI_ISSUER_KMS_KEY_ID', KEY_ARN);

    const signer = await loadSigner(ISSUER_SIGNER, 'testnet', logger);
    const { signature } = await signer.signTransaction(TX_BYTES);

    expect(signer.getKeyScheme()).toBe('ED25519');
    await expect(
      verifyTransactionSignature(TX_BYTES, signature, { address: signer.toSuiAddress() }),
    ).resolves.toBeDefined();
    expect(calls.map((c) => c.target)).toEqual(['TrentService.GetPublicKey', 'TrentService.Sign']);
    expect(calls[1]).toMatchObject({
      url: 'https://kms.ap-southeast-1.amazonaws.com/',
      body: { KeyId: KEY_ARN, MessageType: 'RAW', SigningAlgorithm: 'ED25519_SHA_512' },
    });
  });

  it('turns a high-S secp256k1 DER signature into the low-S compact form Sui requires', async () => {
    stubKms('ECC_SECG_P256K1', { highS: true });
    vi.stubEnv('SUI_PROGRAM_ADMIN_KMS_KEY_ID', 'alias/octap-testnet-program-admin');
    vi.stubEnv('AWS_REGION', 'ap-southeast-1');

    const signer = await loadSigner(PROGRAM_ADMIN_SIGNER, 'testnet', logger);
    const { signature } = await signer.signTransaction(TX_BYTES);

    expect(signer.getKeyScheme()).toBe('Secp256k1');
    // flag || 64-byte compact (r || s) || 33-byte compressed public key
    const raw = Buffer.from(signature, 'base64');
    const s = BigInt(`0x${raw.subarray(33, 65).toString('hex')}`);
    expect(s <= SECP256K1_N / 2n).toBe(true);
    await expect(
      verifyTransactionSignature(TX_BYTES, signature, { address: signer.toSuiAddress() }),
    ).resolves.toBeDefined();
  });

  it('prefers the KMS key over a raw key when both are set', async () => {
    stubKms('ECC_NIST_EDWARDS25519');
    const raw = Ed25519Keypair.generate();
    vi.stubEnv('SUI_ISSUER_KMS_KEY_ID', KEY_ARN);
    vi.stubEnv('SUI_ISSUER_PRIVATE_KEY', raw.getSecretKey());

    const signer = await loadSigner(ISSUER_SIGNER, 'testnet', logger);
    expect(signer.toSuiAddress()).not.toBe(raw.toSuiAddress());
  });

  it('names the key and env var when KMS refuses the key', async () => {
    stubKms('ECC_NIST_EDWARDS25519', { failFirst: 1 });
    vi.stubEnv('SUI_ISSUER_KMS_KEY_ID', KEY_ARN);

    await expect(loadSigner(ISSUER_SIGNER, 'testnet', logger)).rejects.toThrow(
      `AWS KMS key ${KEY_ARN} (SUI_ISSUER_KMS_KEY_ID) is unusable for the Sui chain adapter: {"__type":"AccessDeniedException"`,
    );
  });
});

describe('loadSigner raw-key fallback', () => {
  it('uses the raw key off mainnet, with a warning', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const raw = Ed25519Keypair.generate();
    vi.stubEnv('SUI_ISSUER_KMS_KEY_ID', '');
    vi.stubEnv('SUI_ISSUER_PRIVATE_KEY', raw.getSecretKey());

    const signer = await loadSigner(ISSUER_SIGNER, 'testnet', logger);
    expect(signer.toSuiAddress()).toBe(raw.toSuiAddress());
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('raw key in SUI_ISSUER_PRIVATE_KEY'));
  });

  it('refuses a raw key on mainnet', async () => {
    vi.stubEnv('SUI_ISSUER_KMS_KEY_ID', '');
    vi.stubEnv('SUI_ISSUER_PRIVATE_KEY', Ed25519Keypair.generate().getSecretKey());
    await expect(loadSigner(ISSUER_SIGNER, 'mainnet', logger)).rejects.toThrow(
      /signs on mainnet only through AWS KMS \(SUI_ISSUER_KMS_KEY_ID\)/,
    );
  });

  it('names both options when neither is set (blank counts as unset)', async () => {
    vi.stubEnv('SUI_PROGRAM_ADMIN_KMS_KEY_ID', '  ');
    vi.stubEnv('SUI_PROGRAM_ADMIN_PRIVATE_KEY', '');
    await expect(loadSigner(PROGRAM_ADMIN_SIGNER, 'testnet', logger)).rejects.toThrow(
      'Missing signer for the program admin adapter: set SUI_PROGRAM_ADMIN_KMS_KEY_ID to an AWS KMS key (or SUI_PROGRAM_ADMIN_PRIVATE_KEY to a raw key for local use)',
    );
  });
});

describe('kmsRegion', () => {
  it('reads the region from a key ARN, else from AWS_REGION', () => {
    vi.stubEnv('AWS_REGION', 'us-east-1');
    expect(kmsRegion(KEY_ARN, ISSUER_SIGNER)).toBe('ap-southeast-1');
    expect(kmsRegion('alias/octap-testnet-issuer', ISSUER_SIGNER)).toBe('us-east-1');

    vi.stubEnv('AWS_REGION', '');
    expect(() => kmsRegion('alias/octap-testnet-issuer', ISSUER_SIGNER)).toThrow(
      /Missing required env var AWS_REGION for the Sui chain adapter's KMS key alias\/octap-testnet-issuer/,
    );
  });
});

describe('memoizeSigner', () => {
  it('loads once while it succeeds, and retries after a failed load', async () => {
    const signer = Ed25519Keypair.generate();
    const load = vi.fn().mockRejectedValueOnce(new Error('throttled')).mockResolvedValue(signer);
    const get = memoizeSigner(load);

    await expect(get()).rejects.toThrow('throttled');
    expect(await get()).toBe(signer);
    expect(await get()).toBe(signer);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
