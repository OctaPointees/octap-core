import { describe, expect, it } from 'vitest';
import { WorkerModule } from '../../src/worker.module.js';
import { OrganizationProvisioningWorker } from '#domain/organizations/provisioning.worker.js';
import { ProgramsService } from '#domain/programs/programs.service.js';
import { ChainSubmitWorker } from '#domain/credits/chain-submit.worker.js';
import { CheckpointIndexerWorker } from '#domain/indexer/checkpoint-indexer.worker.js';
import { WebhookDeliveryWorker } from '#domain/webhooks/webhook-delivery.worker.js';

describe('WorkerModule.forJobs (OCT-321)', () => {
  it('loads every job by default', () => {
    const providers = WorkerModule.forJobs().providers ?? [];
    expect(providers).toEqual(
      expect.arrayContaining([
        OrganizationProvisioningWorker,
        ProgramsService,
        ChainSubmitWorker,
        CheckpointIndexerWorker,
      ]),
    );
  });

  it('loads only organization setup for org-setup, so that worker submits, indexes and delivers nothing', () => {
    const providers = WorkerModule.forJobs('org-setup').providers ?? [];
    expect(providers).toEqual(expect.arrayContaining([OrganizationProvisioningWorker, ProgramsService]));
    for (const other of [ChainSubmitWorker, CheckpointIndexerWorker, WebhookDeliveryWorker])
      expect(providers).not.toContain(other);
  });
});
