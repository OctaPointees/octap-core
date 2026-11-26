#!/usr/bin/env node
// Creates the Walrus Console private folder that keeps OctaP's encrypted evidence copies (OCT-77).
// Run once per deployment, then set WALRUS_CONSOLE_BUCKET_ID to the id it prints.
//
//   WALRUS_CONSOLE_NETWORK=mainnet WALRUS_CONSOLE_API_KEY=hbr_… WALRUS_CONSOLE_SERVICE_PRIVATE_KEY=suiprivkey1… \
//     node scripts/walrus-console-folder.mjs [folder-name]
//
// The API key (read_write) and its service key come from Console's Integrations page. The service
// key signs the folder's on-chain access policy once, here; the worker never needs it, only the API key.
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { fromBase64 } from '@mysten/sui/utils';

const API_URLS = {
  mainnet: 'https://api.console.walrus.xyz',
  testnet: 'https://api.beta.testnet.console.walrus.xyz',
};

const network = process.env.WALRUS_CONSOLE_NETWORK ?? 'mainnet';
const apiUrl = API_URLS[network];
const apiKey = process.env.WALRUS_CONSOLE_API_KEY?.trim();
const serviceKey = process.env.WALRUS_CONSOLE_SERVICE_PRIVATE_KEY?.trim();
const name = process.argv[2] ?? 'octap-evidence';
if (!apiUrl) throw new Error(`WALRUS_CONSOLE_NETWORK must be one of ${Object.keys(API_URLS).join(', ')}`);
if (!apiKey || !serviceKey) throw new Error('Set WALRUS_CONSOLE_API_KEY and WALRUS_CONSOLE_SERVICE_PRIVATE_KEY');

async function call(path, init = {}) {
  const res = await globalThis.fetch(`${apiUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...init.headers },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} answered ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

const { data: spaces } = await call('/api/v1/spaces');
if (!spaces?.length) throw new Error('This API key sees no space');
const space = spaces[0];

const reserved = await call(`/api/v1/spaces/${space.id}/buckets`, {
  method: 'POST',
  body: JSON.stringify({ name, scope: 'private' }),
});
const keypair = Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(serviceKey).secretKey);
const { signature } = await keypair.signTransaction(fromBase64(reserved.bytes));
const finalized = await call(`/api/v1/buckets/${reserved.bucket_id}/finalize`, {
  method: 'POST',
  body: JSON.stringify({ signature }),
});

console.log(`Folder "${name}" in space ${space.name ?? space.id} on Walrus Console ${network}:`);
console.log(`  WALRUS_CONSOLE_BUCKET_ID=${finalized.bucket_id}`);
console.log(`  seal policy ${finalized.seal_policy_id} (${finalized.provisioning_state})`);
