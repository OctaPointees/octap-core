import { defineConfig } from 'drizzle-kit';
import dotenv from 'dotenv';
import { resolve } from 'node:path';

// Load .env from repository root or current workspace directory
dotenv.config({ path: resolve(process.cwd(), '../.env') });
dotenv.config({ path: resolve(process.cwd(), '.env') });

export default defineConfig({
  schema: './src/infra/db/schema/index.ts',
  out: './db/postgres/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/octap_dev',
  },
});
