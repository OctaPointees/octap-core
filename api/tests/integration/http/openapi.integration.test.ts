import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp, fakeChainAdapters } from '../support/app.js';
import { openApiLogger, setupOpenApi } from '#api/openapi/openapi.document.js';

describe('API docs over HTTP', () => {
  describe('with OPENAPI_ENABLED=true', () => {
    let ctx: Awaited<ReturnType<typeof createTestApp>>;
    beforeAll(async () => {
      ctx = await createTestApp(fakeChainAdapters(), undefined, (app) =>
        setupOpenApi(app, { OPENAPI_ENABLED: 'true' }),
      );
    });
    afterAll(async () => {
      await ctx.close();
    });

    it('serves the spec without an API key', async () => {
      const res = await ctx.http().get('/docs/openapi.json').expect(200);
      expect(res.body.openapi).toMatch(/^3\./);
      expect(res.body.paths['/v1/credits/earn'].post['x-octap-auth'].kind).toBe('apiKey');
    });

    it('serves Swagger UI', async () => {
      const res = await ctx.http().get('/docs').redirects(1).expect(200);
      expect(res.text).toContain('swagger-ui');
    });

    it('leaves the API routes guarded', async () => {
      await ctx.http().get('/v1/rewards/vouchers').expect(401);
    });
  });

  describe('without OPENAPI_ENABLED', () => {
    let ctx: Awaited<ReturnType<typeof createTestApp>>;
    beforeAll(async () => {
      ctx = await createTestApp(fakeChainAdapters(), undefined, (app) => setupOpenApi(app, {}));
    });
    afterAll(async () => {
      await ctx.close();
    });

    it('does not serve the docs', async () => {
      await ctx.http().get('/docs/openapi.json').expect(404);
      await ctx.http().get('/docs').expect(404);
    });
  });

  describe('when the document cannot be built', () => {
    let ctx: Awaited<ReturnType<typeof createTestApp>>;
    let enabled: boolean | undefined;
    let logged: unknown[][] = [];
    beforeAll(async () => {
      // vitest.config.ts has restoreMocks: the spy is restored before each test, so keep its calls here.
      const spy = vi.spyOn(openApiLogger, 'error').mockImplementation(() => undefined);
      ctx = await createTestApp(fakeChainAdapters(), undefined, (app) => {
        enabled = setupOpenApi(app, { OPENAPI_ENABLED: 'true' }, () => {
          throw new Error('OpenAPI: no handler found for operation Renamed_handler');
        });
      });
      logged = [...spy.mock.calls];
      spy.mockRestore();
    });
    afterAll(async () => {
      await ctx.close();
    });

    it('still starts the API, without docs, and logs why', async () => {
      expect(enabled).toBe(false);
      expect(logged).toEqual([[expect.stringContaining('Renamed_handler'), expect.any(String)]]);
      await ctx.http().get('/docs/openapi.json').expect(404);
      await ctx.http().get('/v1/rewards/vouchers').expect(401);
    });
  });
});
