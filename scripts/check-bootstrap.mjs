import 'reflect-metadata';
import assert from 'node:assert/strict';
import { ModulesContainer, NestFactory } from '@nestjs/core';
import { WorkerModule } from '../api/dist/worker.module.js';
const targets = [['api', '../api/dist/app.module.js', 'AppModule'], ['worker', '../api/dist/worker.module.js', 'WorkerModule']];
for (const [name, path, moduleName] of targets) {
  const modules = await import(path);
  const app = await NestFactory.createApplicationContext(modules[moduleName], { logger: false, abortOnError: false });
  const container = app.get(ModulesContainer);
  const hasWorkers = [...container.values()].some((module) => module.metatype === WorkerModule);
  assert.equal(hasWorkers, name === 'worker', 'HTTP must not load the worker runtime module.');
  await app.close();
  console.log(`${name}: Nest dependency graph initialized and closed`);
}
