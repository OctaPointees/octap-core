import 'reflect-metadata';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { GenericContainer, Wait } from 'testcontainers';
import { Test } from '@nestjs/testing';
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { generateApiKey } from '../api/dist/infra/auth/api-key-hash.util.js';
import { closeDemoResources } from './lib/close-demo-resources.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const cliPath = resolve(repoRoot, 'ts-sdks/packages/mcp/dist/cli.js');
const containers = [];
let database;
let apiDatabase;
let app;

async function connectStdioClient(apiUrl, apiKey) {
  const env = { ...getDefaultEnvironment(), OCTAP_API_URL: apiUrl };
  if (apiKey !== undefined) env.OCTAP_API_KEY = apiKey;
  else delete env.OCTAP_API_KEY;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath],
    cwd: repoRoot,
    env,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'octap-mcp-cli-e2e', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

try {
  assert.ok(existsSync(cliPath), 'Build the MCP CLI before running this script.');
  console.log('Starting disposable PostgreSQL, Redis, and a local Core API…');

  const pg = await new GenericContainer('postgres:17-alpine')
    .withEnvironment({ POSTGRES_USER: 'postgres', POSTGRES_PASSWORD: 'postgres', POSTGRES_DB: 'octap_mcp_e2e' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  containers.push(pg);
  const redis = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();
  containers.push(redis);

  process.env.DATABASE_URL = `postgresql://postgres:postgres@${pg.getHost()}:${pg.getMappedPort(5432)}/octap_mcp_e2e`;
  process.env.REDIS_URL = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
  process.env.SUI_NETWORK = 'testnet';
  database = postgres(process.env.DATABASE_URL, { max: 2, onnotice: () => {} });
  await database.unsafe(
    await (
      await import('node:fs/promises')
    ).readFile(new URL('../docker/postgres-init/01-supabase-compat.sql', import.meta.url), 'utf8'),
  );
  await migrate(drizzle(database), {
    migrationsFolder: fileURLToPath(new URL('../api/db/postgres/migrations', import.meta.url)),
  });
  await database.unsafe('grant select, insert, update, delete on all tables in schema public to authenticated');

  const organizationId = randomUUID();
  const endUserId = randomUUID();
  const memberId = randomUUID();
  const otherOrganizationId = randomUUID();
  const otherEndUserId = randomUUID();
  const otherMemberId = randomUUID();
  const { raw: validKey, prefix, hash } = generateApiKey();
  await database.begin(async (tx) => {
    await tx`insert into organizations (id, slug, name) values (${organizationId}, 'mcp-e2e', 'MCP E2E')`;
    await tx`insert into end_users (id, display_name, sui_address) values (${endUserId}, 'MCP E2E member', '0xmcpdemo')`;
    await tx`insert into organization_end_users (id, organization_id, end_user_id) values (${memberId}, ${organizationId}, ${endUserId})`;
    await tx`insert into credit_ownerships (organization_end_user_id, confirmed_balance, sui_credit_account_id) values (${memberId}, 120, '0xmcpaccount')`;
    await tx`insert into loyalty_transactions (organization_id, organization_end_user_id, transaction_type, points_amount, idempotency_key, status, metadata)
      values (${organizationId}, ${memberId}, 'ADJUSTMENT', 120, 'mcp-e2e-seed', 'CONFIRMED', '{"demo":true}')`;
    await tx`insert into organizations (id, slug, name) values (${otherOrganizationId}, 'mcp-e2e-other', 'MCP E2E Other')`;
    await tx`insert into end_users (id, display_name, sui_address) values (${otherEndUserId}, 'Other organization member', '0xmcpdemoother')`;
    await tx`insert into organization_end_users (id, organization_id, end_user_id) values (${otherMemberId}, ${otherOrganizationId}, ${otherEndUserId})`;
    await tx`insert into credit_ownerships (organization_end_user_id, confirmed_balance, sui_credit_account_id) values (${otherMemberId}, 999, '0xmcpaccountother')`;
    await tx`insert into api_credentials (organization_id, name, key_prefix, key_hash, scopes)
      values (${organizationId}, 'disposable-mcp-e2e', ${prefix}, ${hash}, '["read"]')`;
  });

  const { EnokiClient } = await import('../api/dist/infra/clients/enoki/enoki.client.js');
  const { SuiTransactionBuilderClient } =
    await import('../api/dist/infra/clients/sui/sui-transaction-builder.client.js');
  const { AppModule } = await import('../api/dist/app.module.js');
  const { POSTGRES_CLIENT } = await import('../api/dist/infra/db/postgres.provider.js');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(EnokiClient)
    .useValue({ createSponsoredTransaction: async () => ({}), executeSponsoredTransaction: async () => ({}) })
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
  app = moduleRef.createNestApplication({ logger: false });
  apiDatabase = app.get(POSTGRES_CLIENT);
  await app.listen(0, '127.0.0.1');
  const apiUrl = await app.getUrl();

  const { client } = await connectStdioClient(apiUrl, validKey);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      'get_member_balance',
      'list_member_transactions',
      'list_member_vouchers',
    ]);
    const balance = await client.callTool({ name: 'get_member_balance', arguments: { memberId } });
    assert.equal(balance.isError, undefined);
    assert.equal(JSON.parse(balance.content[0].text).confirmedBalance, 120);
    const transactions = await client.callTool({ name: 'list_member_transactions', arguments: { memberId } });
    assert.equal(transactions.isError, undefined);
    assert.equal(JSON.parse(transactions.content[0].text).length, 1);
    const vouchers = await client.callTool({ name: 'list_member_vouchers', arguments: { memberId } });
    assert.equal(vouchers.isError, undefined);
    assert.deepEqual(JSON.parse(vouchers.content[0].text), []);
  } finally {
    await client.close();
  }
  console.log('Valid key: all three tools connected through the built stdio CLI and returned expected Core data.');

  const { client: invalidClient } = await connectStdioClient(apiUrl, 'invalid-mcp-e2e-key');
  try {
    for (const name of ['get_member_balance', 'list_member_transactions', 'list_member_vouchers']) {
      const response = await invalidClient.callTool({ name, arguments: { memberId } });
      assert.equal(response.isError, true, `${name} should reject an invalid key`);
      assert.match(response.content[0].text, /Core denied this read/);
    }
  } finally {
    await invalidClient.close();
  }
  console.log('Invalid key: all three tools failed with the safe permission error.');

  const { client: crossTenantClient } = await connectStdioClient(apiUrl, validKey);
  try {
    for (const name of ['get_member_balance', 'list_member_transactions', 'list_member_vouchers']) {
      const response = await crossTenantClient.callTool({ name, arguments: { memberId: otherMemberId } });
      assert.equal(response.isError, true, `${name} should reject a member from another organization`);
      assert.match(response.content[0].text, /No matching member or resource was found/);
      assert.doesNotMatch(response.content[0].text, new RegExp(otherMemberId));
    }
  } finally {
    await crossTenantClient.close();
  }
  console.log('Cross-tenant member lookup: all tools returned the generic 404 response.');

  const missingKey = spawnSync(process.execPath, [cliPath], {
    cwd: repoRoot,
    env: { ...getDefaultEnvironment(), OCTAP_API_URL: apiUrl },
    input: '',
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.notEqual(missingKey.status, 0, 'CLI should exit when OCTAP_API_KEY is missing');
  assert.match(missingKey.stderr, /OCTAP_API_KEY is required/);
  assert.doesNotMatch(missingKey.stderr, /\n\s+at /, 'CLI startup errors should not print a stack trace');
  console.log('Missing key: CLI exited immediately with the required-configuration error.');
} catch (error) {
  console.error(`MCP CLI E2E failed: ${error instanceof Error ? error.message : 'unknown error'}`);
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
    console.error('Could not close all MCP E2E resources. Check Docker for remaining containers.');
    process.exitCode = 1;
  }
}
