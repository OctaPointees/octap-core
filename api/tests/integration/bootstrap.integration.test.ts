import { describe, expect, it } from 'vitest';
import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';
import { WorkerModule } from '../../src/worker.module.js';
import { ChainSubmitWorker } from '#domain/credits/chain-submit.worker.js';
import { CheckpointIndexerWorker } from '#domain/indexer/checkpoint-indexer.worker.js';
import { WebhookDeliveryWorker } from '#domain/webhooks/webhook-delivery.worker.js';
import { SuiClientService } from '#infra/clients/sui/sui.client.js';
import { ProgramAdminClient } from '#infra/clients/sui/program-admin.client.js';

const hasModule = (container: ModulesContainer, module: unknown) =>
  [...container.values()].some((m) => m.metatype === module);

/**
 * The same process-boundary rule `scripts/check-bootstrap.mjs` checks, here against the source:
 * the internet-facing HTTP process must never load the worker runtime or a chain signer.
 */
describe('Nest module graphs', () => {
  it('AppModule wires up without the worker module or any signer', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    try {
      expect(hasModule(moduleRef.get(ModulesContainer), WorkerModule)).toBe(false);
      expect(() => moduleRef.get(SuiClientService, { strict: false })).toThrow();
      expect(() => moduleRef.get(ProgramAdminClient, { strict: false })).toThrow();
    } finally {
      await moduleRef.close();
    }
  });

  it('WorkerModule wires up its pollers and both signers, and shuts its loops down cleanly', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    try {
      expect(hasModule(app.get(ModulesContainer), WorkerModule)).toBe(true);
      for (const provider of [
        ChainSubmitWorker,
        CheckpointIndexerWorker,
        WebhookDeliveryWorker,
        SuiClientService,
        ProgramAdminClient,
      ]) {
        expect(app.get(provider, { strict: false })).toBeInstanceOf(provider);
      }
    } finally {
      await app.close();
    }
  });
});
