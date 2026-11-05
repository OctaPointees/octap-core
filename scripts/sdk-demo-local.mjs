import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { GenericContainer, Wait } from 'testcontainers';
import { Test } from '@nestjs/testing';
import { createOctaPointClient } from '@octap/sdk';
import { runVoucherDemo } from './sdk-voucher-demo.mjs';
import { closeDemoResources } from './lib/close-demo-resources.mjs';

// Fresh isolated services, never the developer's configured database or chain wallet.
const containers = [];
let database;
let apiDatabase;
let app;
try {
  console.log('Starting disposable PostgreSQL and Redis for the live SDK demo…');
  const pg = await new GenericContainer('postgres:17-alpine')
    .withEnvironment({ POSTGRES_USER: 'postgres', POSTGRES_PASSWORD: 'postgres', POSTGRES_DB: 'octap_sdk_demo' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  containers.push(pg);
  const redis = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();
  containers.push(redis);
  process.env.DATABASE_URL = `postgresql://postgres:postgres@${pg.getHost()}:${pg.getMappedPort(5432)}/octap_sdk_demo`;
  process.env.REDIS_URL = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
  process.env.SUI_NETWORK = 'testnet';
  database = postgres(process.env.DATABASE_URL, { max: 2, onnotice: () => {} });
  await database.unsafe(
    await readFile(new URL('../docker/postgres-init/01-supabase-compat.sql', import.meta.url), 'utf8'),
  );
  await migrate(drizzle(database), {
    migrationsFolder: fileURLToPath(new URL('../api/db/postgres/migrations', import.meta.url)),
  });
  await database.unsafe('grant select, insert, update, delete on all tables in schema public to authenticated');

  const { generateApiKey } = await import('../api/dist/infra/auth/api-key-hash.util.js');
  const credential = generateApiKey();
  const organizationId = randomUUID();
  const endUserId = randomUUID();
  const memberId = randomUUID();
  await database.begin(async (tx) => {
    await tx`insert into organizations (id, slug, name) values (${organizationId}, 'sdk-local-demo', 'SDK local demo')`;
    await tx`insert into end_users (id, display_name, sui_address) values (${endUserId}, 'Prepared SDK demo member', '0xdemomember')`;
    await tx`insert into organization_end_users (id, organization_id, end_user_id) values (${memberId}, ${organizationId}, ${endUserId})`;
    await tx`insert into credit_ownerships (organization_end_user_id, confirmed_balance, sui_credit_account_id) values (${memberId}, 100, '0xdemoaccount')`;
    await tx`insert into loyalty_transactions (organization_id, organization_end_user_id, transaction_type, points_amount, idempotency_key, status, metadata)
      values (${organizationId}, ${memberId}, 'ADJUSTMENT', 100, 'sdk-demo-initial-balance', 'CONFIRMED', '{"demo":true,"syntheticBalance":true}')`;
    await tx`insert into api_credentials (organization_id, name, key_prefix, key_hash, scopes)
      values (${organizationId}, 'disposable-sdk-demo', ${credential.prefix}, ${credential.hash}, '["read","write"]')`;
  });
  await database`insert into programs (organization_id, status, program_control_id, policy_version_id, issuer_cap_id, policy_version, earn_bps, expiry_ms, shard_count, total_budget, operation_shard_ids, budget_shard_ids)
    values (${organizationId}, 'ACTIVE', '0xprogram', '0xpolicy', '0xissuer', 1, 100, 86400000, 1, 10000, ARRAY['0xop'], ARRAY['0xbudget'])`;
  const { EnokiClient } = await import('../api/dist/infra/clients/enoki/enoki.client.js');
  const { SuiTransactionBuilderClient } =
    await import('../api/dist/infra/clients/sui/sui-transaction-builder.client.js');
  const { AppModule } = await import('../api/dist/app.module.js');
  const { POSTGRES_CLIENT } = await import('../api/dist/infra/db/postgres.provider.js');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(EnokiClient)
    .useValue({
      createSponsoredTransaction: async () => ({ bytes: 'mock-customer-signable-bytes', digest: 'mock-chain-digest' }),
      executeSponsoredTransaction: async ({ digest, signature }) => {
        assert.equal(signature, 'mock-customer-signature');
        return { digest };
      },
    })
    .overrideProvider(SuiTransactionBuilderClient)
    .useValue({
      redeemMoveCallTarget: '0xpkg::credit_account::redeem',
      claimVoucherMoveCallTarget: '0xpkg::credit_account::claim_voucher',
      useVoucherMoveCallTarget: '0xpkg::credit_account::use_voucher',
      buildRedeemTransactionKind: async () => new Uint8Array([1]),
      buildClaimVoucherTransactionKind: async () => new Uint8Array([2]),
      buildUseVoucherTransactionKind: async () => new Uint8Array([3]),
      waitForTransaction: async (digest) => ({ digest, status: 'success', events: [] }),
    })
    .compile();
  app = moduleRef.createNestApplication({ rawBody: true, logger: false });
  apiDatabase = app.get(POSTGRES_CLIENT);
  await app.listen(0, '127.0.0.1');
  const client = createOctaPointClient({
    baseUrl: await app.getUrl(),
    credentials: { apiKey: credential.raw },
    fetchFn: (url, init) => globalThis.fetch(url, { ...init, signal: globalThis.AbortSignal.timeout(15_000) }),
  });
  const voucher = await client.createVoucher({
    code: 'SDK-COFFEE',
    title: 'Demo coffee',
    discountType: 'FREE_ITEM',
    pointsCost: 25,
    totalSupply: 1,
  });
  // No worker runs here: this is what it does once the chain holds the voucher's terms.
  const { RewardsRepository } = await import('../api/dist/infra/db/repositories/rewards.repository.js');
  await app.get(RewardsRepository).markVoucherPublished(voucher.id, '0xmockterms');
  const config = {
    memberId,
    voucherId: voucher.id,
    idempotencyKey: 'sdk-demo-local-claim',
    signTransaction: async () => 'mock-customer-signature',
  };
  console.log(
    'Prepared a synthetic 100-point member and a 25-point reward. Chain sponsorship, signature and verdict are mocked; API, holds and PostgreSQL settlement are real.',
  );
  const result = await runVoucherDemo(client, config);
  const replay = await client.claimVoucher(voucher.id, {
    organizationEndUserId: memberId,
    idempotencyKey: config.idempotencyKey,
  });
  assert.equal(replay.voucherOwnershipId, result.claim.voucherOwnershipId);
  assert.equal(replay.status, 'REDEEMED');
  await assert.rejects(
    client.prepareVoucherUse({ serialCode: result.claim.serialCode, idempotencyKey: 'sdk-demo-second-use' }),
    (error) => error.statusCode === 400,
  );
  assert.equal((await client.getBalance(memberId)).confirmedBalance, 75);
  console.log('Also verified: claim replay returns the original result; a second redemption is rejected.');
} catch (error) {
  console.error(`Local SDK demo failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
} finally {
  try {
    await closeDemoResources([
      () => app?.close(),
      () => apiDatabase?.end({ timeout: 5 }),
      () => database?.end({ timeout: 5 }),
      ...containers.reverse().map((container) => () => container.stop()),
    ]);
  } catch {
    console.error('Could not close all local demo resources. Check Docker for remaining containers.');
    process.exitCode = 1;
  }
}
