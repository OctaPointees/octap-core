import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module.js';
const app = await NestFactory.createApplicationContext(WorkerModule);
app.enableShutdownHooks();
Logger.log('Worker running (ChainSubmitWorker); staying alive until SIGINT/SIGTERM.');
// Deliberately no app.close() here: ChainSubmitWorker owns a setInterval poll loop that must
// keep running for the process's lifetime. enableShutdownHooks() above wires SIGINT/SIGTERM to
// a graceful app.close() (which clears that interval via onModuleDestroy), so this process exits
// only on signal, not immediately after boot like the pre-worker placeholder did.
