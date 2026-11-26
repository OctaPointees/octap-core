import { describe, expect, it, vi } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

const latestEvidenceSealId = vi.fn();
const readSeal = vi.fn();
vi.mock('@octap/chain', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@octap/chain')>()),
  latestEvidenceSealId,
}));
vi.mock('@octap/verify', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@octap/verify')>()),
  suiSealReader: vi.fn(() => ({ readSeal })),
}));

const { TESTNET_OCTAP_AUDIT_CONFIG } = await import('@octap/chain');
const { SuiClientService } = await import('#infra/clients/sui/sui.client.js');

const PARAMS = {
  organizationId: '0b6c2f1e-1111-4222-8333-444455556666',
  periodStartMs: 0,
  periodEndMs: 86_400_000,
  manifestHash: 'ab'.repeat(32),
  previousManifestHash: null,
};

function service(client: Record<string, unknown>) {
  const s = new SuiClientService();
  (s as unknown as { chainClient: unknown }).chainClient = client;
  return s;
}

describe('SuiClientService evidence seals (OCT-77)', () => {
  it('seals on the ledger network with the issuer key, and exposes the seal event', async () => {
    vi.stubEnv('SUI_ISSUER_PRIVATE_KEY', Ed25519Keypair.generate().getSecretKey());
    const signAndExecute = vi.fn(async () => ({
      digest: 'D1',
      status: 'success',
      events: [
        {
          type: `${TESTNET_OCTAP_AUDIT_CONFIG.packageId}::evidence_seal::EvidenceSealed`,
          parsedJson: { seal_id: '0xs' },
        },
      ],
    }));
    const s = service({ signAndExecute });
    expect(s.evidenceNetwork).toBe('testnet');
    expect(s.evidencePackageId).toBe(TESTNET_OCTAP_AUDIT_CONFIG.packageId);
    const result = await s.sealEvidence(PARAMS);
    expect(result.eventField('EvidenceSealed', 'seal_id')).toBe('0xs');
    const [tx] = signAndExecute.mock.calls[0] as unknown as [{ getData(): { gasData: { budget: string } } }];
    expect(tx.getData().gasData.budget).toBe('20000000');
  });

  it('reads the latest seal through the registry, or null before the first', async () => {
    const rpc = {};
    const s = service({ rpc });
    latestEvidenceSealId.mockResolvedValueOnce(null);
    await expect(s.latestEvidenceSeal(PARAMS.organizationId)).resolves.toBeNull();
    expect(readSeal).not.toHaveBeenCalled();

    latestEvidenceSealId.mockResolvedValueOnce('0xseal');
    readSeal.mockResolvedValueOnce({ sealObjectId: '0xseal', manifestHash: PARAMS.manifestHash });
    await expect(s.latestEvidenceSeal(PARAMS.organizationId)).resolves.toMatchObject({ sealObjectId: '0xseal' });
    expect(latestEvidenceSealId).toHaveBeenLastCalledWith(rpc, TESTNET_OCTAP_AUDIT_CONFIG, PARAMS.organizationId);
  });

  it('refuses evidence seals on a network with no published octap_audit package', () => {
    vi.stubEnv('SUI_NETWORK', 'mainnet');
    expect(() => new SuiClientService().evidencePackageId).toThrow(/No octap_audit package configured/);
  });
});
