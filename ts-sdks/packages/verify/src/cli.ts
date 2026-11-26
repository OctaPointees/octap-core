#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import type { EvidenceBundle } from '@octap/contracts';
import { suiscanTransactionUrl } from './networks.js';
import { suiSealReader } from './seal.js';
import { verifyBundle } from './verify.js';

const USAGE = `Usage:
  octap-verify <bundle.json> [--rpc <url>]

Checks an Octap audit evidence bundle against its seal on Sui, read straight from a fullnode.
Exits 0 on MATCH, 1 on MISMATCH, 2 on a usage or read error.`;

async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const rpcAt = args.indexOf('--rpc');
  const rpcUrl = rpcAt >= 0 ? args.splice(rpcAt, 2)[1] : undefined;
  const [file] = args;
  if (!file || file === '--help' || file === '-h' || args.length > 1) {
    console.log(USAGE);
    return file ? 0 : 2;
  }
  const bundle = JSON.parse(await readFile(file, 'utf8')) as EvidenceBundle;
  const result = await verifyBundle(bundle, suiSealReader(bundle.seal?.network, { rpcUrl }));
  const where = bundle.manifest
    ? `${bundle.manifest.organizationId}, ${bundle.manifest.periodStart} → ${bundle.manifest.periodEnd}`
    : file;
  if (result.result === 'MATCH' && result.seal) {
    const digest = result.seal.transactionDigest;
    console.log(`✓ MATCH — ${where}`);
    console.log(`  sealed on-chain at ${new Date(result.seal.sealedAtMs).toISOString()}`);
    console.log(`  ${bundle.ledger.length} ledger facts, ${bundle.audit.length} audit facts`);
    if (digest) console.log(`  ${suiscanTransactionUrl(bundle.seal.network, digest)}`);
    return 0;
  }
  console.log(`✗ MISMATCH (${result.mismatched.join(', ')}) — ${where}`);
  for (const reason of result.reasons) console.log(`  ${reason}`);
  return 1;
}

// exitCode, not exit(): exiting while the gRPC connection is still closing aborts Node on Windows.
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 2;
  },
);
