import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { getFaucetHost, requestSuiFromFaucetV3 } from '@mysten/sui/faucet';

/**
 * Tạo 2 ví testnet mới (issuer + admin) cho máy này, tự xin gas từ faucet, rồi ghi
 * SUI_ISSUER_PRIVATE_KEY / SUI_PROGRAM_ADMIN_PRIVATE_KEY vào .env — không cần Sui CLI,
 * không cần biết gì về wallet/crypto, không cần vào trang faucet.
 *
 * Usage: node temp/generate-testnet-keys.mjs
 */
const ENV_PATH = '.env';
const host = getFaucetHost('testnet');

async function makeFundedKeypair(label) {
  const keypair = Ed25519Keypair.generate();
  const address = keypair.getPublicKey().toSuiAddress();
  console.log(`[${label}] address: ${address} — đang xin gas từ faucet...`);
  try {
    await requestSuiFromFaucetV3({ host, recipient: address });
    console.log(`[${label}] đã nhận gas.`);
  } catch (e) {
    console.warn(
      `[${label}] faucet lỗi (${e.message}) — có thể do rate limit, thử lại sau vài phút bằng tay tại https://faucet.sui.io`,
    );
  }
  return { address, secretKey: keypair.getSecretKey() };
}

const issuer = await makeFundedKeypair('issuer');
const admin = await makeFundedKeypair('admin');

let env = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
function setVar(env, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  return re.test(env) ? env.replace(re, line) : env.replace(/\n?$/, `\n${line}\n`);
}
env = setVar(env, 'SUI_ISSUER_PRIVATE_KEY', issuer.secretKey);
env = setVar(env, 'SUI_PROGRAM_ADMIN_PRIVATE_KEY', admin.secretKey);
if (!/^SUI_NETWORK=/m.test(env)) env = setVar(env, 'SUI_NETWORK', 'testnet');
writeFileSync(ENV_PATH, env);

console.log('\nĐã ghi SUI_ISSUER_PRIVATE_KEY và SUI_PROGRAM_ADMIN_PRIVATE_KEY vào .env.');
console.log('Tiếp theo: npm run db:migrate, rồi node --env-file=.env temp/demo-setup.mjs');
