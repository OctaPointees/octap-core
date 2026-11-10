import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, fakeChainAdapters } from '../support/app.js';
import { setupOpenApi } from '#api/openapi/openapi.document.js';

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
});
