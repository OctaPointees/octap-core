import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
const app = await NestFactory.create(AppModule);
app.enableShutdownHooks();
await app.listen(Number(process.env.API_PORT ?? 3000), process.env.API_HOST ?? '127.0.0.1');
Logger.log('API listening.');
