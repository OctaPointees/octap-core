import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from '../api/dist/worker.module.js';
import { AppModule } from '../api/dist/app.module.js';
import { ProgramsService } from '../api/dist/domain/programs/programs.service.js';
import { SuiClientService } from '../api/dist/infra/clients/sui/sui.client.js';
import { ApiCredentialsService } from '../api/dist/infra/auth/api-credentials.service.js';
import postgres from 'postgres';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

/**
 * Setup demo 1 lệnh: tạo organization mới, provision program on-chain, seed API credential,
 * tạo 1 "khách hàng demo" (keypair thật, không qua Google/Enoki), enroll vào org.
 * In ra cuối cùng block CONFIG để dán vào temp/login.html.
 *
 * Yêu cầu trước khi chạy: `npm install && npm run build`, Postgres+Redis đã up (docker-compose
 * up -d), `.env` đã điền DATABASE_URL/SUI_NETWORK/SUI_ISSUER_PRIVATE_KEY/SUI_PROGRAM_ADMIN_PRIVATE_KEY
 * (2 ví testnet riêng của máy này, đã xin gas ở https://faucet.testnet.sui.io).
 *
 * Usage: node --env-file=.env temp/demo-setup.mjs
 */
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

const [org] = await sql`
  insert into organizations (slug, name) values (${'demo-' + Date.now()}, 'Demo Org')
  returning id
`;
console.log('organization:', org.id);

const workerApp = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
const programs = workerApp.get(ProgramsService);
const sui = workerApp.get(SuiClientService);

const program = await programs.provisionForOrganization({
  organizationId: org.id,
  earnBps: 500,
  expiryMs: 365 * 24 * 60 * 60 * 1000,
  issuerRecipient: sui.issuerAddress(),
  shardCount: 1,
  totalBudget: 1_000_000,
});
console.log('program provisioned:', program.programControlId);
await workerApp.close();

const httpApp = await NestFactory.createApplicationContext(AppModule, { logger: false });
const credentials = httpApp.get(ApiCredentialsService);
const { rawKey } = await credentials.issue(org.id, 'demo-key', ['read', 'write', 'admin']);
await httpApp.close();

const customerKeypair = Ed25519Keypair.generate();
const customerAddress = customerKeypair.getPublicKey().toSuiAddress();
const customerSecret = customerKeypair.getSecretKey();
const [endUser] = await sql`
  insert into end_users (sui_address, display_name) values (${customerAddress}, 'Demo Customer')
  returning id
`;
const [enrollment] = await sql`
  insert into organization_end_users (organization_id, end_user_id) values (${org.id}, ${endUser.id})
  returning id
`;

console.log('\n--- Dán block này vào đầu <script type="module"> trong temp/login.html ---\n');
console.log(`const ORG_ID = '${org.id}';`);
console.log(`const KEY_A = '${rawKey}';`);
console.log(`const CUSTOMER_KEY = '${customerSecret}';`);
console.log(`const FALLBACK_END_USER_ID = '${endUser.id}';`);
console.log(`const FALLBACK_SUI_ADDRESS = '${customerAddress}';`);
console.log(`// organizationEndUserId (OEU_ID) đã enroll sẵn: ${enrollment.id}`);

await sql.end();
