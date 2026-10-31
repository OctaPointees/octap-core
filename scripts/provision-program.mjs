import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from '../api/dist/worker.module.js';
import { ProgramsService } from '../api/dist/domain/programs/programs.service.js';
import { SuiClientService } from '../api/dist/infra/clients/sui/sui.client.js';

/**
 * One-time per-organization on-chain provisioning: creates a program, publishes+activates a
 * policy, mints an IssuerCap for the chain-submit worker's own issuer signer, and creates the
 * program's operation/budget shards. There is no HTTP endpoint for this yet — see
 * docs/roadmap.md's Programs known gap.
 * Usage: node scripts/provision-program.mjs <organizationId> <earnBps> <expiryDays> <totalBudget> [shardCount=1]
 */
const USAGE =
  'Usage: node scripts/provision-program.mjs <organizationId> <earnBps> <expiryDays> <totalBudget> [shardCount=1]';
const [organizationId, earnBpsRaw, expiryDaysRaw, totalBudgetRaw, shardCountRaw = '1'] = process.argv.slice(2);
if (!organizationId || !earnBpsRaw || !expiryDaysRaw || !totalBudgetRaw) {
  console.error(USAGE);
  process.exit(1);
}

const earnBps = Number(earnBpsRaw);
const expiryMs = Number(expiryDaysRaw) * 24 * 60 * 60 * 1000;
const totalBudget = Number(totalBudgetRaw);
const shardCount = Number(shardCountRaw);

const app = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
const programs = app.get(ProgramsService);
const sui = app.get(SuiClientService);

const issuerRecipient = await sui.issuerAddress();
const program = await programs.provisionForOrganization({
  organizationId,
  earnBps,
  expiryMs,
  issuerRecipient,
  shardCount,
  totalBudget,
});

console.log(`Provisioned program ${program.programControlId} for organization ${organizationId}`);
console.log(`  policy ${program.policyVersionId} (${earnBps} bps, ${expiryDaysRaw}-day expiry)`);
console.log(`  issuer cap ${program.issuerCapId} issued to ${issuerRecipient}`);
console.log(`  ${shardCount} shard(s), total budget ${totalBudget}`);
console.log(`  operation shards ${program.operationShardIds.join(', ')}`);
console.log(`  budget shards ${program.budgetShardIds.join(', ')}`);

await app.close();
