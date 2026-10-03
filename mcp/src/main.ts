import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
const app = await NestFactory.create(AppModule);
app.enableShutdownHooks();
await app.listen(Number(process.env.MCP_PORT ?? 3001), process.env.MCP_HOST ?? '127.0.0.1');
Logger.log('MCP scaffold listening; no business tools or MCP endpoint registered.');
