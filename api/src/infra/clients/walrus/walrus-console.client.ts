import { randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { SealClient } from '@mysten/seal';
import { bcs } from '@mysten/sui/bcs';
import { SuiGrpcClient } from '@mysten/sui/grpc';

/**
 * Walrus Console per network: its API, and the Seal setup its private folders encrypt under. A
 * Console network is independent of OctaP's own Sui network: the copy is just stored there.
 * Public ids from Console's own deployment records and Seal's verified committee list.
 */
const CONSOLE_NETWORKS = {
  mainnet: {
    apiUrl: 'https://api.console.walrus.xyz',
    fullnodeUrl: 'https://fullnode.mainnet.sui.io:443',
    /** Console's bucket-policy package (original id: Seal derives identities from it). */
    policyPackageId: '0xb8d5b1cade7917190c47b8abfc789f527389fc021a8963c22755bcc1b539786c',
    sealCommitteeObjectId: '0x686098f1439237fff9f36b99c7329683c22979d2005c2465cb891acb012a7595',
  },
  testnet: {
    apiUrl: 'https://api.beta.testnet.console.walrus.xyz',
    fullnodeUrl: 'https://fullnode.testnet.sui.io:443',
    policyPackageId: '0xf9b261d4c0dbcf845d79f864e85581f9686fd6de9f4770ba1d77489d67f7833c',
    sealCommitteeObjectId: '0xb012378c9f3799fb5b1a7083da74a4069e3c3f1c93de0b27212a5799ce1e1e98',
  },
} as const;

export type WalrusConsoleNetwork = keyof typeof CONSOLE_NETWORKS;
export const WALRUS_CONSOLE_NETWORKS = Object.keys(CONSOLE_NETWORKS) as WalrusConsoleNetwork[];

/** Console's per-file Seal identity: the folder's policy object, then 32 random bytes. */
const SealIdentity = bcs.struct('SealIdentity', {
  policyObjectId: bcs.Address,
  nonce: bcs.fixedArray(32, bcs.u8()),
});

export type ArchivedFileState =
  { state: 'uploading' } | { state: 'completed'; blobId: string } | { state: 'failed'; error: string };

/**
 * Keeps OctaP's encrypted copy of each evidence bundle in a Walrus Console private folder (OCT-77).
 * Files are Seal-encrypted here, before upload, so Console and Walrus only ever hold ciphertext,
 * and only holders of the folder's access policy can decrypt.
 *
 * Off unless `WALRUS_CONSOLE_API_KEY` and `WALRUS_CONSOLE_BUCKET_ID` are both set: sealing never
 * waits on it, and each period's archive status then reads `DISABLED`. The folder is created once
 * with `scripts/walrus-console-folder.mjs`.
 */
@Injectable()
export class WalrusConsoleClient {
  private readonly logger = new Logger(WalrusConsoleClient.name);
  private readonly network: WalrusConsoleNetwork =
    (process.env.WALRUS_CONSOLE_NETWORK as WalrusConsoleNetwork | undefined) ?? 'mainnet';
  private seal?: SealClient;
  private policyId?: string;

  get enabled(): boolean {
    return Boolean(this.apiKey && this.bucketId);
  }

  private get apiKey(): string | undefined {
    return process.env.WALRUS_CONSOLE_API_KEY?.trim() || undefined;
  }

  private get bucketId(): string | undefined {
    return process.env.WALRUS_CONSOLE_BUCKET_ID?.trim() || undefined;
  }

  private get config() {
    return CONSOLE_NETWORKS[this.network];
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.config.apiUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.apiKey}`, ...init.headers },
    });
    const text = await res.text();
    if (!res.ok)
      throw new Error(`Walrus Console ${init.method ?? 'GET'} ${path} answered ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  }

  /**
   * The folder's Seal policy, from Console's upload preflight (`GET /buckets/{id}/policy`), cached
   * once it is resolvable. Any other state refuses the upload; the next run asks again.
   */
  private async sealPolicyId(): Promise<string> {
    if (!this.policyId) {
      const { data } = await this.request<{ data: { state: string; seal_policy_id: string | null; reason?: string } }>(
        `/api/v1/buckets/${this.bucketId}/policy`,
      );
      if (data.state !== 'resolvable' || !data.seal_policy_id)
        throw new Error(
          `Walrus Console folder ${this.bucketId} is not ready for uploads (policy ${data.state}${data.reason ? `: ${data.reason}` : ''})`,
        );
      this.policyId = data.seal_policy_id;
    }
    return this.policyId;
  }

  private get sealClient(): SealClient {
    this.seal ??= new SealClient({
      suiClient: new SuiGrpcClient({ network: this.network, baseUrl: this.config.fullnodeUrl }),
      serverConfigs: [
        {
          objectId: this.config.sealCommitteeObjectId,
          weight: 1,
          aggregatorUrl: `${this.config.apiUrl}/api/v1/seal/aggregator`,
          apiKeyName: 'Authorization',
          apiKey: `Bearer ${this.apiKey}`,
        },
      ],
      // The aggregator URL is Console's proxy, not a registered server URL; every key share is still
      // checked against the committee object's on-chain public key.
      verifyKeyServers: false,
    });
    return this.seal;
  }

  /** Encrypts `plaintext` for the folder's policy and uploads it. Returns Console's file id. */
  async upload(name: string, plaintext: Uint8Array): Promise<string> {
    if (!this.enabled) throw new Error('Walrus Console archive is not configured');
    const policyObjectId = await this.sealPolicyId();
    const id = SealIdentity.serialize({ policyObjectId, nonce: Array.from(randomBytes(32)) }).toHex();
    const { encryptedObject } = await this.sealClient.encrypt({
      threshold: 1,
      packageId: this.config.policyPackageId,
      id,
      data: plaintext,
    });
    const form = new FormData();
    form.set('file', new Blob([Uint8Array.from(encryptedObject)], { type: 'application/octet-stream' }), name);
    form.set('name', name);
    const { data } = await this.request<{ data: { id: string } }>(`/api/v1/buckets/${this.bucketId}/files`, {
      method: 'POST',
      body: form,
    });
    this.logger.log(`uploaded ${name} to Walrus Console as ${data.id}`);
    return data.id;
  }

  /** Whether an uploaded file has reached Walrus yet, and its blob id once it has. */
  async fileState(fileId: string): Promise<ArchivedFileState> {
    // The file record is authoritative: the upload job's status is dropped from the queue after a
    // while (404), the record keeps its blob id.
    const base = `/api/v1/buckets/${this.bucketId}/files/${fileId}`;
    const { data: file } = await this.request<{ data: { blob_id: string | null; status?: string } }>(base);
    if (file.blob_id) return { state: 'completed', blobId: file.blob_id };
    const res = await fetch(`${this.config.apiUrl}${base}/status`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) return { state: 'uploading' };
    const { data: status } = (await res.json()) as {
      data: { state: string; error?: { code: string; message: string } };
    };
    if (status.state === 'failed')
      return { state: 'failed', error: status.error ? `${status.error.code}: ${status.error.message}` : 'failed' };
    return { state: 'uploading' };
  }
}
