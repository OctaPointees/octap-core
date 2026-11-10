// Writes docs/openapi.json from the built API (run `npm run build` first).
// `--check` fails instead of writing when the committed file is out of date (CI).
//
// `preview: true` builds the Nest module graph without instantiating providers, so no Postgres,
// Redis or Sui connection is needed to describe the routes.
import 'reflect-metadata';
import { readFileSync, writeFileSync } from 'node:fs';
import { URL } from 'node:url';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../api/dist/app.module.js';
import { buildOpenApiDocument } from '../api/dist/api/openapi/openapi.document.js';

const target = new URL('../docs/openapi.json', import.meta.url);
const check = process.argv.includes('--check');

const app = await NestFactory.create(AppModule, { preview: true, logger: false, abortOnError: false });
const document = buildOpenApiDocument(app);
await app.close();

const next = `${JSON.stringify(document, null, 2)}\n`;
const operations = Object.values(document.paths).flatMap((item) => Object.keys(item)).length;

if (check) {
  let current = '';
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    // Missing file is reported as out of date below.
  }
  if (current !== next) {
    console.error('docs/openapi.json is out of date. Run `npm run build && npm run openapi:generate` and commit it.');
    process.exit(1);
  }
  console.log(`docs/openapi.json is up to date (${operations} operations).`);
} else {
  writeFileSync(target, next);
  console.log(`Wrote docs/openapi.json (${operations} operations).`);
}
