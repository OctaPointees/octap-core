import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  // Same as tsconfig.base.json's experimentalDecorators/emitDecoratorMetadata: Nest DI resolves
  // constructor parameters by their `design:paramtypes` metadata (no `@Inject` on class
  // dependencies in this codebase), so booting `AppModule` in a test needs it emitted.
  oxc: {
    decorator: { legacy: true, emitDecoratorMetadata: true },
  },
  resolve: {
    // Tests run against workspace sources directly, so nothing has to be built first.
    alias: [
      { find: '@octap/contracts', replacement: fromRoot('./ts-sdks/packages/contracts/src/index.ts') },
      { find: '@octap/chain', replacement: fromRoot('./ts-sdks/packages/chain/src/index.ts') },
      { find: '@octap/sdk', replacement: fromRoot('./ts-sdks/packages/node/src/index.ts') },
      { find: '@octap/browser-sdk', replacement: fromRoot('./ts-sdks/packages/browser/src/index.ts') },
      // api/package.json's `imports` map #api/#domain/#infra to dist/ for Node; tests want src/.
      { find: /^#(api|domain|infra)\//, replacement: `${fromRoot('./api/src/')}$1/` },
    ],
  },
  test: {
    globals: false,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    setupFiles: [fromRoot('./api/tests/setup.ts')],
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['api/tests/unit/**/*.test.ts', 'ts-sdks/packages/*/tests/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['api/tests/integration/**/*.integration.test.ts'],
          // Every request comes from one IP and Redis is not reset between tests.
          env: { PUBLIC_RATE_LIMIT_MAX_REQUESTS: '100000' },
          globalSetup: [fromRoot('./api/tests/integration/support/global-setup.ts')],
          // Every file shares one Postgres/Redis and truncates between tests, so files run one at a time.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['api/src/**/*.ts', 'ts-sdks/packages/*/src/**/*.ts'],
      exclude: [
        // @mysten/codegen output: generated, "DO NOT MODIFY".
        'ts-sdks/packages/chain/src/contracts/**',
        // Process entrypoints: top-level await boot + listen; covered by check:bootstrap.
        'api/src/main.ts',
        'api/src/worker.ts',
        // Declarative drizzle tables: their policy/reference callbacks only run inside drizzle-kit.
        'api/src/infra/db/schema/**',
      ],
      reporter: ['text-summary', 'text', 'html', 'lcov'],
      reportOnFailure: true,
      thresholds: {
        statements: 95,
        branches: 90,
        functions: 95,
        lines: 95,
      },
    },
  },
});
