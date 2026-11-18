import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../api/dist/app.module.js';
import { ApiCredentialsService } from '../api/dist/infra/auth/api-credentials.service.js';

/**
 * Issues a `read` + `write` API credential for an organization, the same scopes an Owner's console
 * key gets. For local development without the console. Webhooks and the refund policy are managed
 * from the console, not with a key.
 * Usage: node scripts/seed-dev-credential.mjs <organizationId> [name]
 */
const [organizationId, name = 'bootstrap-dev'] = process.argv.slice(2);
if (!organizationId) {
  console.error('Usage: node scripts/seed-dev-credential.mjs <organizationId> [name]');
  process.exit(1);
}

const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
const credentials = app.get(ApiCredentialsService);
const { credential, rawKey } = await credentials.issue(organizationId, name, ['read', 'write']);

console.log(`Issued API credential ${credential.id} for organization ${organizationId}`);
console.log(`Raw key (store it now; it cannot be recovered): ${rawKey}`);

await app.close();
