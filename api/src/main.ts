import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
// rawBody: true preserves the exact request bytes on request.rawBody — request signature
// verification (infra/auth/request-signing.util.ts) must hash what was actually sent, not a
// re-serialized JSON.stringify(request.body), which can differ in key order/whitespace.
const app = await NestFactory.create(AppModule, { rawBody: true });
app.enableShutdownHooks();
// Permissive for now — there is no authentication/tenant check yet either (see docs/roadmap.md's
// known gaps), so this isn't loosening a real security boundary. Scope this to an allowlist once
// API keys/auth land.
app.enableCors();
await app.listen(Number(process.env.API_PORT ?? 3000), process.env.API_HOST ?? '127.0.0.1');
Logger.log('API listening.');
