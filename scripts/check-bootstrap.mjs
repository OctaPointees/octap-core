import 'reflect-metadata';
import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';

for (const name of ['api', 'mcp', 'worker']) {
  const { AppModule } = await import(`../apps/${name}/dist/app.module.js`);
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
    abortOnError: false,
  });
  assert.ok(app);
  await app.close();
  console.log(`${name}: Nest dependency graph initialized and closed`);
}
