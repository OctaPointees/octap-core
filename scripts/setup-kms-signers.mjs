import { execFileSync } from 'node:child_process';
import { constants, createPublicKey, publicEncrypt } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair, Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';

/**
 * One-time AWS setup for the testnet worker signers (docs/kms-signer.md). For each signer it
 * creates an Ed25519 KMS key with imported key material, behind `alias/octap-<env>-<signer>`, and
 * imports the raw key from `.env` into it, so the Sui address (and every IssuerCap/AdminCap it
 * holds) stays the same. The key travels only wrapped under the KMS-issued RSA-4096 wrapping key
 * and is never printed. It then creates the shared signer IAM user (kms:Sign + kms:GetPublicKey on
 * both keys, nothing else) and one role per key for a worker on AWS compute.
 * Safe to re-run: an existing key, user or role is reused, and an imported key is only verified
 * against the address of the raw key in `.env`. Needs the AWS CLI, signed in as an identity that
 * can manage KMS and IAM in the account; the region comes from AWS_REGION or the CLI profile.
 * Usage: AWS_PROFILE=<admin> node --env-file=.env scripts/setup-kms-signers.mjs [env=testnet]
 */
const ENV = process.argv[2] ?? 'testnet';
const SIGNERS = [
  { name: 'issuer', privateKeyEnv: 'SUI_ISSUER_PRIVATE_KEY' },
  { name: 'program-admin', privateKeyEnv: 'SUI_PROGRAM_ADMIN_PRIVATE_KEY' },
];
const SIGNER_USER = `octap-${ENV}-signer`;
const TAGS = { project: 'octap', env: ENV };
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const work = mkdtempSync(join(tmpdir(), 'octap-kms-'));
const aws = (...args) => {
  const out = execFileSync('aws', [...args, '--output', 'json'], { encoding: 'utf8' }).trim();
  return out ? JSON.parse(out) : undefined;
};
const awsOrUndefined = (...args) => {
  try {
    return aws(...args);
  } catch {
    return undefined;
  }
};
const file = (name, contents) => {
  const path = join(work, name);
  writeFileSync(path, contents);
  return path;
};
const policy = (statements) => JSON.stringify({ Version: '2012-10-17', Statement: statements });

function seed(privateKeyEnv) {
  const value = process.env[privateKeyEnv]?.trim();
  if (!value) throw new Error(`${privateKeyEnv} is not set; it is the key to import`);
  const { scheme, secretKey } = decodeSuiPrivateKey(value);
  if (scheme !== 'ED25519') throw new Error(`${privateKeyEnv} is ${scheme}, expected ED25519`);
  return secretKey;
}

function kmsAddress(keyId) {
  const spki = Buffer.from(aws('kms', 'get-public-key', '--key-id', keyId).PublicKey, 'base64');
  if (!spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    throw new Error(`KMS key ${keyId} is not an Ed25519 key`);
  }
  return new Ed25519PublicKey(spki.subarray(ED25519_SPKI_PREFIX.length)).toSuiAddress();
}

function importKeyMaterial(keyId, privateKeyEnv) {
  const params = aws(
    'kms',
    'get-parameters-for-import',
    '--key-id',
    keyId,
    '--wrapping-algorithm',
    'RSAES_OAEP_SHA_256',
    '--wrapping-key-spec',
    'RSA_4096',
  );
  const wrappingKey = createPublicKey({ key: Buffer.from(params.PublicKey, 'base64'), format: 'der', type: 'spki' });
  const pkcs8 = Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed(privateKeyEnv))]);
  const wrapped = publicEncrypt(
    { key: wrappingKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    pkcs8,
  );
  pkcs8.fill(0);
  aws(
    'kms',
    'import-key-material',
    '--key-id',
    keyId,
    '--encrypted-key-material',
    `fileb://${file('key-material.bin', wrapped)}`,
    '--import-token',
    `fileb://${file('import-token.bin', Buffer.from(params.ImportToken, 'base64'))}`,
    '--expiration-model',
    'KEY_MATERIAL_DOES_NOT_EXPIRE',
  );
}

function ensureKey({ name, privateKeyEnv }) {
  const alias = `alias/octap-${ENV}-${name}`;
  const expected = Ed25519Keypair.fromSecretKey(seed(privateKeyEnv)).toSuiAddress();
  let metadata = awsOrUndefined('kms', 'describe-key', '--key-id', alias)?.KeyMetadata;
  if (!metadata) {
    metadata = aws(
      'kms',
      'create-key',
      '--origin',
      'EXTERNAL',
      '--key-spec',
      'ECC_NIST_EDWARDS25519',
      '--key-usage',
      'SIGN_VERIFY',
      '--description',
      `OctaP ${ENV} Sui ${name} signer (${expected})`,
      '--tags',
      ...Object.entries({ ...TAGS, signer: name }).map(([k, v]) => `TagKey=${k},TagValue=${v}`),
    ).KeyMetadata;
    aws('kms', 'create-alias', '--alias-name', alias, '--target-key-id', metadata.KeyId);
  }
  if (metadata.Origin !== 'EXTERNAL')
    throw new Error(`${alias} holds KMS-generated key material, not ${privateKeyEnv}`);
  if (metadata.KeyState === 'PendingImport') {
    importKeyMaterial(metadata.KeyId, privateKeyEnv);
    console.log(`imported ${privateKeyEnv} into ${alias}`);
  }
  const actual = kmsAddress(metadata.KeyId);
  if (actual !== expected) throw new Error(`${alias} signs as ${actual}, but ${privateKeyEnv} is ${expected}`);
  console.log(`${alias} = ${expected}  (${metadata.Arn})`);
  return metadata.Arn;
}

const iamTags = Object.entries(TAGS).map(([k, v]) => `Key=${k},Value=${v}`);

try {
  const account = aws('sts', 'get-caller-identity').Account;
  console.log(`account ${account}`);
  const [issuerKeyArn, adminKeyArn] = SIGNERS.map(ensureKey);

  // The dev team's shared signer identity: the AWS counterpart of Harbor's GCP service account.
  if (!awsOrUndefined('iam', 'get-user', '--user-name', SIGNER_USER)) {
    aws('iam', 'create-user', '--user-name', SIGNER_USER, '--tags', ...iamTags);
  }
  const signBoth = policy([
    { Effect: 'Allow', Action: ['kms:Sign', 'kms:GetPublicKey'], Resource: [issuerKeyArn, adminKeyArn] },
  ]);
  aws('iam', 'put-user-policy', '--user-name', SIGNER_USER, '--policy-name', 'kms-sign', '--policy-document', signBoth);
  console.log(`user ${SIGNER_USER}`);

  // One role per key, for a worker on AWS compute (task role, pod identity, instance profile).
  const trust = policy([
    { Effect: 'Allow', Principal: { AWS: `arn:aws:iam::${account}:root` }, Action: 'sts:AssumeRole' },
  ]);
  const roles = {
    [`Octap${ENV[0].toUpperCase()}${ENV.slice(1)}IssuerSigner`]: [
      { Effect: 'Allow', Action: ['kms:Sign', 'kms:GetPublicKey'], Resource: issuerKeyArn },
    ],
    [`Octap${ENV[0].toUpperCase()}${ENV.slice(1)}ProgramAdmin`]: [
      { Effect: 'Allow', Action: ['kms:Sign', 'kms:GetPublicKey'], Resource: adminKeyArn },
      { Effect: 'Allow', Action: 'kms:GetPublicKey', Resource: issuerKeyArn },
    ],
  };
  for (const [role, statements] of Object.entries(roles)) {
    if (!awsOrUndefined('iam', 'get-role', '--role-name', role)) {
      aws('iam', 'create-role', '--role-name', role, '--assume-role-policy-document', trust, '--tags', ...iamTags);
    }
    aws(
      'iam',
      'put-role-policy',
      '--role-name',
      role,
      '--policy-name',
      'kms-sign',
      '--policy-document',
      policy(statements),
    );
    console.log(`role arn:aws:iam::${account}:role/${role}`);
  }

  console.log(`\nNext: aws iam create-access-key --user-name ${SIGNER_USER} (shown once; hand it out privately).`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
