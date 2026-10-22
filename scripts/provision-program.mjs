import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from '../api/dist/worker.module.js';
import { ProgramsService } from '../api/dist/domain/programs/programs.service.js';
import { SuiClientService } from '../api/dist/infra/clients/sui/sui.client.js';

/**
 * One-time per-organization on-chain provisioning: creates a program, publishes+activates a
 * policy, and mints an IssuerCap for the chain-submit worker's own issuer signer. There is no
 * HTTP endpoint for this yet — see docs/roadmap.md's Programs known gap.
 * Usage: node scripts/provision-program.mjs <organizationId> <earnBps> <expiryDays>
 */
const [organizationId, earnBpsRaw, expiryDaysRaw] = process.argv.slice(2);
if (!organizationId || !earnBpsRaw || !expiryDaysRaw) {
  console.error('Usage: node scripts/provision-program.mjs <organizationId> <earnBps> <expiryDays>');
  process.exit(1);
}

const earnBps = Number(earnBpsRaw);
const expiryMs = Number(expiryDaysRaw) * 24 * 60 * 60 * 1000;

const app = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
const programs = app.get(ProgramsService);
const sui = app.get(SuiClientService);

const issuerRecipient = sui.issuerAddress();
const program = await programs.provisionForOrganization({ organizationId, earnBps, expiryMs, issuerRecipient });

console.log(`Provisioned program ${program.programControlId} for organization ${organizationId}`);
console.log(`  policy ${program.policyVersionId} (${earnBps} bps, ${expiryDaysRaw}-day expiry)`);
console.log(`  issuer cap ${program.issuerCapId} issued to ${issuerRecipient}`);

await app.close();
