import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { parseTrustedProxyHops } from '#infra/auth/public-rate-limit.guard.js';
import { OPENAPI_DOCS_PATH, setupOpenApi } from '#api/openapi/openapi.document.js';
const app = await NestFactory.create<NestExpressApplication>(AppModule);
// Decides what `request.ip` is, and so which client public-route rate limits count against.
app.set('trust proxy', parseTrustedProxyHops(process.env.TRUSTED_PROXY_HOPS));
app.enableShutdownHooks();
// Permissive for now — there is no authentication/tenant check yet either (see docs/roadmap.md's
// known gaps), so this isn't loosening a real security boundary. Scope this to an allowlist once
// API keys/auth land.
app.enableCors();
// Swagger UI at /docs and the raw spec at /docs/openapi.json, only where OPENAPI_ENABLED=true
// (local, staging): the document lists every route, including platform-admin ones.
if (setupOpenApi(app)) Logger.log(`API docs at /${OPENAPI_DOCS_PATH}.`);
await app.listen(Number(process.env.API_PORT ?? 3000), process.env.API_HOST ?? '127.0.0.1');
Logger.log('API listening.');
