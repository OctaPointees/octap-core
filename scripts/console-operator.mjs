import 'reflect-metadata';
import { appendFileSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../api/dist/app.module.js';
import {
  ConsoleOperatorRepository,
  ConsoleOperatorError,
} from '../api/dist/infra/db/repositories/console-operator.repository.js';
import { GoogleIdentityClient } from '../api/dist/infra/clients/google/google-identity.client.js';

const { values } = parseArgs({
  options: {
    action: { type: 'string' },
    'user-id': { type: 'string' },
    operator: { type: 'string' },
    reason: { type: 'string' },
    'audit-file': { type: 'string' },
  },
});
if (
  !['bootstrap-admin', 'link'].includes(values.action) ||
  !values.operator?.trim() ||
  !values.reason?.trim() ||
  !values['audit-file'] ||
  (values.action === 'link' && !values['user-id']) ||
  (values['user-id'] && !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(values['user-id']))
) {
  throw new Error(
    'Usage: console-operator.mjs --action bootstrap-admin|link [--user-id UUID] --operator NAME --reason TEXT --audit-file PATH; pipe the Google ID token through stdin',
  );
}
if (process.stdin.isTTY) throw new Error('Supply the Google ID token through stdin; never as a command-line argument');
let token = '';
for await (const chunk of process.stdin) {
  token += chunk.toString();
  if (token.length > 16384) throw new Error('Google ID token is too large');
}
token = token.trim();
if (!token) throw new Error('A Google ID token is required on stdin');
const fd = openSync(values['audit-file'], 'a', 0o600);
const operationId = randomUUID();
const record = (stage, details = {}) => {
  appendFileSync(
    fd,
    JSON.stringify({
      operationId,
      timestamp: new Date().toISOString(),
      stage,
      operator: values.operator,
      osUser: userInfo().username,
      host: hostname(),
      reason: values.reason,
      action: values.action,
      ...details,
    }) + '\n',
  );
  fsyncSync(fd);
};
let app;
try {
  record('started', { targetUserId: values['user-id'] ?? null });
  app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const identity = await app.get(GoogleIdentityClient).verify(token);
  token = '';
  const change = await app
    .get(ConsoleOperatorRepository)
    .execute({ action: values.action, userId: values['user-id'] }, identity, (change) => record('prepared', change));
  record('committed', change);
  console.log(JSON.stringify({ operationId, ...change }));
} catch (error) {
  // Do not print upstream errors: vendor errors can include credential-bearing requests.
  record('failed-or-commit-unconfirmed', error instanceof ConsoleOperatorError ? { error: error.message } : {});
  if (error instanceof ConsoleOperatorError) console.error(error.message);
  console.error(
    `Operator action failed or commit could not be confirmed; inspect audit operation ${operationId} and database before retrying.`,
  );
  process.exitCode = 1;
} finally {
  token = '';
  closeSync(fd);
  await app?.close();
}
