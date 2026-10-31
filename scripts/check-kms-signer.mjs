import { performance } from 'node:perf_hooks';
import { Logger } from '@nestjs/common';
import { verifyTransactionSignature } from '@mysten/sui/verify';
import { ISSUER_SIGNER, PROGRAM_ADMIN_SIGNER, loadSigner } from '../api/dist/infra/clients/sui/signer.js';

/**
 * Smoke-tests the worker's Sui signers end to end and measures what each signature costs: loads
 * the signer exactly as the worker does (AWS KMS when `SUI_*_KMS_KEY_ID` is set), prints its Sui
 * address and scheme, then signs `samples` dummy transaction payloads, verifies every signature
 * locally, and reports the round-trip latency. Nothing is sent to the chain. See
 * docs/kms-signer.md for provisioning the keys this checks.
 * Usage: node --env-file=.env scripts/check-kms-signer.mjs [issuer|admin|both=both] [samples=20]
 */
const USAGE = 'Usage: node --env-file=.env scripts/check-kms-signer.mjs [issuer|admin|both] [samples]';
const [which = 'both', samplesRaw = '20'] = process.argv.slice(2);
const sources = { issuer: [ISSUER_SIGNER], admin: [PROGRAM_ADMIN_SIGNER], both: [ISSUER_SIGNER, PROGRAM_ADMIN_SIGNER] }[
  which
];
const samples = Number(samplesRaw);
if (!sources || !Number.isSafeInteger(samples) || samples < 1) {
  console.error(USAGE);
  process.exit(1);
}

const network = process.env.SUI_NETWORK ?? 'testnet';
const logger = new Logger('check-kms-signer');
const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

for (const source of sources) {
  const kmsKeyId = process.env[source.kmsKeyIdEnv]?.trim();
  console.log(`\n${source.adapter} (${kmsKeyId ? `AWS KMS ${kmsKeyId}` : `raw key ${source.privateKeyEnv}`})`);

  const loadStart = performance.now();
  const signer = await loadSigner(source, network, logger);
  console.log(`  load (GetPublicKey + credentials): ${(performance.now() - loadStart).toFixed(0)} ms`);
  console.log(`  address ${signer.toSuiAddress()}  scheme ${signer.getKeyScheme()}`);

  const latencies = [];
  for (let i = 0; i < samples; i++) {
    const bytes = Buffer.from(`octap kms signer check ${Date.now()} ${i}`);
    const start = performance.now();
    const { signature } = await signer.signTransaction(bytes);
    latencies.push(performance.now() - start);
    await verifyTransactionSignature(bytes, signature, { address: signer.toSuiAddress() });
  }
  latencies.sort((a, b) => a - b);
  const mean = latencies.reduce((sum, ms) => sum + ms, 0) / latencies.length;
  console.log(
    `  ${samples} signatures verified; sign latency ms: p50 ${percentile(latencies, 50).toFixed(0)}, ` +
      `p95 ${percentile(latencies, 95).toFixed(0)}, max ${latencies.at(-1).toFixed(0)}, mean ${mean.toFixed(0)}`,
  );
}
