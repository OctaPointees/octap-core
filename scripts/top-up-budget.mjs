import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from '../api/dist/worker.module.js';
import { ProgramsService } from '../api/dist/domain/programs/programs.service.js';

/**
 * Refills an organization's on-chain issuance budget without re-provisioning its program, e.g.
 * after a demo program's budget shard drained and every earn started aborting with
 * `EBudgetExceeded`. Signed by the program admin signer (the program's `AdminCap` holder);
 * `amount` is split across the program's budget shards like the initial budget.
 * Usage: node scripts/top-up-budget.mjs <organizationId> <amount>
 */
const USAGE = 'Usage: node scripts/top-up-budget.mjs <organizationId> <amount>';
const [organizationId, amountRaw] = process.argv.slice(2);
if (!organizationId || !amountRaw) {
  console.error(USAGE);
  process.exit(1);
}

const app = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
const programs = app.get(ProgramsService);

const topUps = await programs.topUpBudget({ organizationId, amount: Number(amountRaw) });

console.log(`Topped up organization ${organizationId}'s budget by ${amountRaw} credits`);
for (const topUp of topUps) {
  console.log(`  shard ${topUp.budgetShardId}: +${topUp.amount}, now ${topUp.remaining}`);
}

await app.close();
