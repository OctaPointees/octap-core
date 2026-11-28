import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module.js';
import { assertValidEnv, type WorkerJobSet } from '#config/env.js';
// Before any worker starts polling: a missing signer or a bad interval fails here, not on the first job.
assertValidEnv('worker');
// Validated above: unset or one of WORKER_JOB_SETS.
const jobs = (process.env.WORKER_JOBS ?? 'all') as WorkerJobSet;
const app = await NestFactory.createApplicationContext(WorkerModule.forJobs(jobs));
app.enableShutdownHooks();
Logger.log(`Worker running (WORKER_JOBS=${jobs}); staying alive until SIGINT/SIGTERM.`);
// Deliberately no app.close() here: ChainSubmitWorker owns a setInterval poll loop that must
// keep running for the process's lifetime. enableShutdownHooks() above wires SIGINT/SIGTERM to
// a graceful app.close() (which clears that interval via onModuleDestroy), so this process exits
// only on signal, not immediately after boot like the pre-worker placeholder did.
