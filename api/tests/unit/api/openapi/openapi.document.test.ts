import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { ModulesContainer, NestFactory } from '@nestjs/core';
import type { OpenAPIObject, OperationObject } from '@nestjs/swagger';
import { AppModule } from '../../../../src/app.module.js';
import { buildOpenApiDocument, isOpenApiEnabled, tagFor } from '#api/openapi/openapi.document.js';

let app: INestApplication;
let document: OpenAPIObject;

beforeAll(async () => {
  // Same as scripts/openapi.mjs: no provider is instantiated, so no Postgres/Redis/Sui is needed.
  app = await NestFactory.create(AppModule, { preview: true, logger: false, abortOnError: false });
  document = buildOpenApiDocument(app);
});

afterAll(async () => {
  await app.close();
});

const operations = () =>
  Object.entries(document.paths).flatMap(([path, item]) =>
    Object.entries(item).map(([method, operation]) => ({ path, method, operation: operation as OperationObject })),
  );

const operation = (method: string, path: string) => {
  const found = operations().find((o) => o.method === method && o.path === path);
  if (!found) throw new Error(`${method} ${path} is not in the document`);
  return found.operation as OperationObject & { 'x-octap-auth': Record<string, unknown> };
};

/** Every handler with a Nest route decorator, read straight from controller metadata. */
function routeHandlerCount(): number {
  let count = 0;
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const prototype = (wrapper.metatype as { prototype: object } | undefined)?.prototype;
      if (!prototype) continue;
      for (const name of Object.getOwnPropertyNames(prototype)) {
        const handler = (prototype as Record<string, unknown>)[name];
        if (
          typeof handler === 'function' &&
          Reflect.getMetadata(PATH_METADATA, handler) !== undefined &&
          Reflect.getMetadata(METHOD_METADATA, handler) !== undefined
        )
          count += 1;
      }
    }
  }
  return count;
}

describe('OpenAPI document', () => {
  it('describes every route handler exactly once', () => {
    const ids = operations().map((o) => o.operation.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(routeHandlerCount());
  });

  it('gives every operation a tag, an auth kind, a security requirement and an error response', () => {
    for (const { operation: op } of operations()) {
      expect(op.tags?.length, op.operationId).toBe(1);
      expect(op.security, op.operationId).toBeDefined();
      expect((op as unknown as Record<string, unknown>)['x-octap-auth'], op.operationId).toBeDefined();
      expect(op.responses['4XX'], op.operationId).toBeDefined();
    }
    const declared = new Set(document.tags?.map((t) => t.name));
    for (const { operation: op } of operations()) expect(declared.has(op.tags![0])).toBe(true);
  });

  it('resolves every local $ref', () => {
    const refs = JSON.stringify(document).match(/"\$ref":"#\/components\/[^"]+"/g) ?? [];
    for (const ref of refs) {
      const [, kind, name] = /#\/components\/([^/]+)\/([^"]+)/.exec(ref)!;
      const section = (document.components as Record<string, Record<string, unknown> | undefined>)[kind];
      expect(section?.[name], ref).toBeDefined();
    }
  });

  it('reads auth from the same metadata the guards enforce', () => {
    expect(operation('post', '/v1/credits/earn')['x-octap-auth']).toEqual({
      kind: 'apiKey',
      scopes: ['write'],
      signedRequest: false,
    });
    expect(operation('post', '/v1/credits/earn').security).toEqual([{ apiKey: [] }]);

    const create = operation('post', '/v1/api-credentials');
    expect(create['x-octap-auth']).toEqual({ kind: 'apiKey', scopes: ['admin'], signedRequest: true });
    expect(create.security).toEqual([{ apiKey: [], signedTimestamp: [], signedNonce: [], signedSignature: [] }]);

    expect(operation('get', '/v1/console/organizations/{organizationId}/members')['x-octap-auth']).toEqual({
      kind: 'console',
      platformAdminOnly: false,
    });
    expect(operation('get', '/v1/platform/organizations')['x-octap-auth']).toEqual({
      kind: 'console',
      platformAdminOnly: true,
    });
    const finalize = operation('post', '/v1/credits/redeem/finalize');
    expect(finalize['x-octap-auth']).toEqual({ kind: 'public', rateLimited: true });
    expect(finalize.security).toEqual([]);
  });

  it('treats a public route that reads Authorization itself as a console route', () => {
    const me = operation('get', '/v1/console/me');
    expect(me['x-octap-auth']).toEqual({ kind: 'console', platformAdminOnly: false });
    expect(me.parameters?.some((p) => 'name' in p && p.name.toLowerCase() === 'authorization')).toBe(false);
  });

  it('documents the optional X-Organization-Id header on API-key routes only', () => {
    const header = { $ref: '#/components/parameters/OrganizationIdHeader' };
    expect(operation('post', '/v1/credits/earn').parameters).toContainEqual(header);
    expect(operation('get', '/v1/console/me').parameters ?? []).not.toContainEqual(header);
  });
});

describe('OpenAPI helpers', () => {
  it('serves docs only when OPENAPI_ENABLED is exactly "true"', () => {
    expect(isOpenApiEnabled({})).toBe(false);
    expect(isOpenApiEnabled({ OPENAPI_ENABLED: 'false' })).toBe(false);
    expect(isOpenApiEnabled({ OPENAPI_ENABLED: '1' })).toBe(false);
    expect(isOpenApiEnabled({ OPENAPI_ENABLED: 'true' })).toBe(true);
  });

  it('names a tag after its controller', () => {
    expect(tagFor('ConsoleOrganizationsController')).toBe('Console Organizations');
    expect(tagFor('CreditsController')).toBe('Credits');
  });
});
