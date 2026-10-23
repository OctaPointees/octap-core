import { describe, expect, it, vi } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { OctapChainClient, SubmittedChainTransaction } from '@octap/chain';
import { ProgramAdminClient } from '#infra/clients/sui/program-admin.client.js';

const PARAMS = {
  earnBps: 100,
  expiryMs: 2_592_000_000,
  issuerRecipient: '0xissuer',
  shardCount: 2,
  totalBudget: 1_000,
};

const ok = (events: SubmittedChainTransaction['events']): SubmittedChainTransaction => ({
  digest: 'D',
  status: 'success',
  events,
});
const failed = (errorMessage?: string): SubmittedChainTransaction => ({
  digest: 'D',
  status: 'failure',
  errorMessage,
  events: [],
});
const ev = (name: string, parsedJson: unknown) => ({ type: `0xpkg::mod::${name}`, parsedJson });

const created = ok([ev('ProgramCreated', { program_id: '0xprogram', admin_cap_id: '0xadmincap' })]);
const published = ok([ev('PolicyPublished', { policy_version_id: '0xpolicy' })]);
const activated = ok([
  ev('IssuerCapIssued', { issuer_cap_id: '0xissuercap' }),
  // Deliberately out of order: ids must come back sorted by shard_index.
  ev('OperationShardCreated', { shard_id: '0xop1', shard_index: '1' }),
  ev('OperationShardCreated', { shard_id: '0xop0', shard_index: '0' }),
  ev('BudgetShardCreated', { shard_id: '0xbudget1', shard_index: '1' }),
  ev('BudgetShardCreated', { shard_id: '0xbudget0', shard_index: '0' }),
]);

function adminWith(results: SubmittedChainTransaction[]) {
  vi.stubEnv('SUI_PROGRAM_ADMIN_PRIVATE_KEY', Ed25519Keypair.generate().getSecretKey());
  const tx = () => ({ setGasBudget: vi.fn() });
  const client = {
    buildCreateProgramTransaction: vi.fn(tx),
    buildPublishPolicyTransaction: vi.fn(tx),
    buildActivatePolicyAndIssueCapTransaction: vi.fn(tx),
    signAndExecute: vi.fn(),
  };
  for (const result of results) {
    client.signAndExecute.mockResolvedValueOnce(result);
  }
  const admin = new ProgramAdminClient();
  (admin as unknown as { chainClient: unknown }).chainClient = client;
  return { admin, client };
}

describe('ProgramAdminClient.provisionProgram', () => {
  it('runs create -> publish -> activate+issue+shards, returning shard ids in index order', async () => {
    const { admin, client } = adminWith([created, published, activated]);

    expect(await admin.provisionProgram(PARAMS)).toEqual({
      programId: '0xprogram',
      adminCapId: '0xadmincap',
      policyVersionId: '0xpolicy',
      issuerCapId: '0xissuercap',
      operationShardIds: ['0xop0', '0xop1'],
      budgetShardIds: ['0xbudget0', '0xbudget1'],
    });
    expect(client.buildPublishPolicyTransaction).toHaveBeenCalledWith({
      adminCapId: '0xadmincap',
      programId: '0xprogram',
      version: 1,
      earnBps: 100,
      expiryMs: 2_592_000_000,
    });
    expect(client.buildActivatePolicyAndIssueCapTransaction).toHaveBeenCalledWith({
      adminCapId: '0xadmincap',
      programId: '0xprogram',
      policyVersionId: '0xpolicy',
      issuerRecipient: '0xissuer',
      shards: { shardCount: 2, totalBudget: 1_000 },
    });
    expect(client.signAndExecute).toHaveBeenCalledTimes(3);
  });

  it('rejects bad shard inputs before sending any transaction', async () => {
    const { admin, client } = adminWith([]);
    await expect(admin.provisionProgram({ ...PARAMS, shardCount: 0 })).rejects.toThrow(/shardCount/);
    await expect(admin.provisionProgram({ ...PARAMS, shardCount: 1.5 })).rejects.toThrow(/shardCount/);
    await expect(admin.provisionProgram({ ...PARAMS, totalBudget: -1 })).rejects.toThrow(/totalBudget/);
    expect(client.signAndExecute).not.toHaveBeenCalled();
  });

  it.each([
    ['create_program fails', [failed('EAbort')], /EAbort/],
    ['create_program fails silently', [failed()], /create_program failed on-chain/],
    ['ProgramCreated is missing', [ok([])], /did not emit ProgramCreated/],
    ['publish fails', [created, failed('EBadPolicy')], /EBadPolicy/],
    ['publish fails silently', [created, failed()], /policy_version::publish failed on-chain/],
    ['PolicyPublished is missing', [created, ok([])], /did not emit PolicyPublished/],
    ['activate fails', [created, published, failed('EPaused')], /EPaused/],
    ['activate fails silently', [created, published, failed()], /activate_policy\/issue_cap\/create_shards failed/],
    ['IssuerCapIssued is missing', [created, published, ok([])], /did not emit IssuerCapIssued/],
    [
      'shard events are short',
      [
        created,
        published,
        ok([
          ev('IssuerCapIssued', { issuer_cap_id: '0xcap' }),
          ev('OperationShardCreated', { shard_id: 'a', shard_index: '0' }),
        ]),
      ],
      /emitted 1 operation \/ 0 budget shard event\(s\), expected 2 each/,
    ],
  ])('throws when %s', async (_label, results, message) => {
    const { admin } = adminWith(results as SubmittedChainTransaction[]);
    await expect(admin.provisionProgram(PARAMS)).rejects.toThrow(message);
  });

  it('needs SUI_PROGRAM_ADMIN_PRIVATE_KEY before signing', async () => {
    const { admin } = adminWith([]);
    vi.stubEnv('SUI_PROGRAM_ADMIN_PRIVATE_KEY', '');
    await expect(admin.provisionProgram(PARAMS)).rejects.toThrow(
      /SUI_PROGRAM_ADMIN_PRIVATE_KEY for the program admin adapter/,
    );
  });

  it('builds the real chain client lazily, and refuses a network with no package', () => {
    const admin = new ProgramAdminClient();
    const client = (admin as unknown as { client: OctapChainClient }).client;
    expect((admin as unknown as { client: OctapChainClient }).client).toBe(client);

    vi.stubEnv('SUI_NETWORK', 'mainnet');
    expect(() => (new ProgramAdminClient() as unknown as { client: OctapChainClient }).client).toThrow(
      /No octap package configured/,
    );
  });
});
