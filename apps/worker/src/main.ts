import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
const app = await NestFactory.createApplicationContext(AppModule);
app.enableShutdownHooks();
Logger.log('Worker scaffold initialized; no consumers or schedules registered.');
await app.close();
