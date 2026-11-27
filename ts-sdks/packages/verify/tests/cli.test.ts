import { afterEach, describe, expect, it, vi } from 'vitest';

const readFile = vi.fn();
const verifyBundle = vi.fn();
vi.mock('node:fs/promises', () => ({ readFile }));
vi.mock('../src/seal.js', () => ({ suiSealReader: vi.fn(() => ({})) }));
vi.mock('../src/verify.js', () => ({ verifyBundle }));

const bundle = {
  manifest: { organizationId: 'org', periodStart: 'A', periodEnd: 'B' },
  seal: { network: 'testnet' },
  ledger: [{}],
  audit: [],
};

/** Runs the CLI once with `args`; returns its exit code and output. */
async function run(...args: string[]) {
  vi.resetModules();
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => void lines.push(line));
  vi.spyOn(console, 'error').mockImplementation((line: string) => void lines.push(line));
  vi.stubGlobal('process', { ...process, argv: ['node', 'octap-verify', ...args], exitCode: undefined });
  await import('../src/cli.js');
  await vi.waitFor(() => expect(process.exitCode).toBeDefined());
  return { code: process.exitCode, out: lines.join('\n') };
}

describe('octap-verify', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('exits 0 on MATCH and links the seal transaction', async () => {
    readFile.mockResolvedValue(JSON.stringify(bundle));
    verifyBundle.mockResolvedValue({ result: 'MATCH', seal: { sealedAtMs: 0, transactionDigest: 'TX' } });
    const { code, out } = await run('bundle.json', '--rpc', 'http://node');
    expect(code).toBe(0);
    expect(out).toContain('✓ MATCH — org, A → B');
    expect(out).toContain('https://suiscan.xyz/testnet/tx/TX');
  });

  it('exits 1 on MISMATCH with its reasons', async () => {
    readFile.mockResolvedValue(JSON.stringify(bundle));
    verifyBundle.mockResolvedValue({ result: 'MISMATCH', mismatched: ['ledger'], reasons: ['changed'], seal: null });
    const { code, out } = await run('bundle.json');
    expect(code).toBe(1);
    expect(out).toContain('✗ MISMATCH (ledger)');
    expect(out).toContain('changed');
  });

  it('prints usage, and exits 2 on a missing file argument or an unreadable file', async () => {
    expect((await run()).code).toBe(2);
    expect((await run('--help')).out).toContain('Usage:');
    readFile.mockRejectedValue(new Error('ENOENT'));
    const { code, out } = await run('missing.json');
    expect(code).toBe(2);
    expect(out).toContain('ENOENT');
  });
});
