import { type Provider } from '@nestjs/common';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export const DRIZZLE_DB = Symbol('DRIZZLE_DB');
export const POSTGRES_CLIENT = Symbol('POSTGRES_CLIENT');

export type DrizzleDb = PostgresJsDatabase<typeof schema>;

export const postgresClientProvider: Provider = {
  provide: POSTGRES_CLIENT,
  useFactory: () => {
    const databaseUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/octap_dev';
    return postgres(databaseUrl, {
      prepare: false, // Required for Supabase transaction pooler (port 6543)
      max: Number(process.env.DB_MAX_CONNECTIONS ?? 10),
      idle_timeout: 20,
      connect_timeout: 10,
      onnotice: () => {},
    });
  },
};

export const drizzleProvider: Provider = {
  provide: DRIZZLE_DB,
  useFactory: (client: postgres.Sql) => {
    return drizzle(client, { schema });
  },
  inject: [POSTGRES_CLIENT],
};
