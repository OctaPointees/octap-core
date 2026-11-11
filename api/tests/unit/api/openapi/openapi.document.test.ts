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

    expect(operation('put', '/v1/rewards/refund-policy')['x-octap-auth']).toEqual({
      kind: 'apiKey',
      scopes: ['admin'],
      signedRequest: false,
    });
    // `@RequireSignedRequest()` is kept, but no route requires a signed request today.
    for (const { operation: op } of operations()) {
      expect((op as unknown as { 'x-octap-auth': { signedRequest?: boolean } })['x-octap-auth'].signedRequest).not.toBe(
        true,
      );
    }
    expect(operation('post', '/v1/console/organizations/{organizationId}/api-credentials')['x-octap-auth']).toEqual({
      kind: 'console',
      platformAdminOnly: false,
    });

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

describe('OpenAPI request and response schemas', () => {
  const schemas = () => document.components!.schemas as Record<string, Record<string, unknown>>;
  const resolve = (schema: Record<string, unknown>): Record<string, unknown> =>
    typeof schema.$ref === 'string' ? resolve(schemas()[schema.$ref.split('/').pop()!]) : schema;
  const bodyOf = (method: string, path: string) =>
    resolve(
      (operation(method, path).requestBody as { content: Record<string, { schema: Record<string, unknown> }> }).content[
        'application/json'
      ].schema,
    );

  it('is OpenAPI 3.1, because the generated schemas use JSON Schema type arrays', () => {
    expect(document.openapi).toBe('3.1.0');
  });

  it('gives every operation a JSON success response schema', () => {
    for (const { operation: op } of operations()) {
      const success = Object.entries(op.responses).find(([status]) => /^2\d\d$/.test(status));
      expect(success, op.operationId).toBeDefined();
      expect((success![1] as { content?: unknown }).content, op.operationId).toBeDefined();
    }
  });

  it('describes a typed body with its required fields', () => {
    const earn = bodyOf('post', '/v1/credits/earn');
    expect(earn.required).toEqual(
      expect.arrayContaining(['organizationEndUserId', 'purchaseAmount', 'idempotencyKey']),
    );
    expect(Object.keys(earn.properties as object)).toContain('receiptReference');
  });

  it('describes bodies that the services validate by hand (Wire<…> DTOs)', () => {
    const patch = bodyOf('patch', '/v1/console/organizations/{organizationId}/members/{memberId}');
    expect(Object.keys(patch.properties as object).sort()).toEqual(['externalMemberId', 'metadata', 'status']);
    const apply = bodyOf('post', '/v1/console/organization-requests');
    expect(apply.required).toEqual(expect.arrayContaining(['name', 'slug', 'organizationType']));
  });

  it('describes an inferred response type that has no named interface', () => {
    const response = operation('get', '/v1/organizations/resolve/{slug}').responses['200'] as unknown as {
      content: Record<string, { schema: Record<string, unknown> }>;
    };
    expect(resolve(response.content['application/json'].schema).required).toEqual(
      expect.arrayContaining(['organizationId', 'name', 'slug']),
    );
  });

  it('expands a typed query object into query parameters', () => {
    const names = (operation('get', '/v1/console/organizations/{organizationId}/members').parameters ?? [])
      .filter((p) => 'in' in p && p.in === 'query')
      .map((p) => ('name' in p ? p.name : ''));
    expect(names.sort()).toEqual(['cursor', 'externalMemberId', 'limit', 'q', 'status']);
  });

  it('documents a keyed @Query param as optional when the handler signature makes it optional', () => {
    const query = (method: string, path: string) =>
      Object.fromEntries(
        (operation(method, path).parameters ?? [])
          .filter((p) => 'in' in p && p.in === 'query')
          .map((p) => ('name' in p ? [p.name, p] : ['', p])),
      ) as Record<string, { required?: boolean; schema?: Record<string, unknown> }>;
    expect(query('get', '/v1/credits/members/{memberId}/balance').programId.required).toBe(false);
    expect(query('get', '/v1/credits/members/{memberId}/transactions').limit.required).toBe(false);
    const history = query('get', '/v1/rewards/refund-policy/history');
    expect(history.limit).toMatchObject({ required: false, schema: { type: 'number' } });
    expect(history.beforeVersion.required).toBe(false);
    expect(query('get', '/v1/platform/owner-candidates').q.required).toBe(false);
    // Path params stay required.
    const memberId = operation('get', '/v1/credits/members/{memberId}/balance').parameters?.find(
      (p) => 'in' in p && p.in === 'path' && p.name === 'memberId',
    );
    expect(memberId).toMatchObject({ required: true });
  });

  it('documents no query param twice', () => {
    for (const { operation: op } of operations()) {
      const names = (op.parameters ?? [])
        .filter((p) => 'in' in p && p.in === 'query')
        .map((p) => ('name' in p ? p.name : ''));
      expect(new Set(names).size, op.operationId).toBe(names.length);
    }
  });

  it('does not describe a body on GET routes', () => {
    for (const { method, operation: op } of operations()) if (method === 'get') expect(op.requestBody).toBeUndefined();
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
