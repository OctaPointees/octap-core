import { Module } from '@nestjs/common';
import { WalrusConsoleClient } from './walrus-console.client.js';

/**
 * Walrus Console (OCT-77). Imported by `worker.module.ts` only: archiving runs in the worker, and
 * the HTTP process has no reason to hold the Console API key.
 */
@Module({ providers: [WalrusConsoleClient], exports: [WalrusConsoleClient] })
export class WalrusConsoleModule {}
