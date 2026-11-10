import type { INestApplication, Type } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { ModulesContainer } from '@nestjs/core';
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
  type OperationObject,
  type ParameterObject,
  type ReferenceObject,
} from '@nestjs/swagger';
import { IS_PUBLIC_KEY } from '#infra/auth/public.decorator.js';
import { PublicRateLimitGuard } from '#infra/auth/public-rate-limit.guard.js';
import { SCOPES_KEY } from '#infra/auth/scopes.decorator.js';
import { REQUIRE_SIGNED_REQUEST_KEY } from '#infra/auth/signed-request.decorator.js';
import { ConsoleAccessGuard, PLATFORM_ADMIN_ONLY_KEY } from '#api/rest/console-access.guard.js';

/** Swagger UI is served at `/docs`, the raw document at `/docs/openapi.json`. */
export const OPENAPI_DOCS_PATH = 'docs';
export const OPENAPI_JSON_PATH = `${OPENAPI_DOCS_PATH}/openapi.json`;

export const SECURITY_SCHEMES = {
  apiKey: 'apiKey',
  consoleSession: 'consoleSession',
  signedTimestamp: 'signedTimestamp',
  signedNonce: 'signedNonce',
  signedSignature: 'signedSignature',
} as const;

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

/**
 * How a route is authenticated, read from the same metadata the guards enforce (`@Public()`,
 * `@UseGuards(ConsoleAccessGuard)`, `@PlatformAdminOnly()`, `@Scopes()`, `@RequireSignedRequest()`),
 * so the document cannot drift from the guards and a new route needs no swagger decorator for auth.
 */
export type RouteAccess =
  | { kind: 'apiKey'; scopes: string[]; signed: boolean }
  | { kind: 'console'; platformAdminOnly: boolean }
  | { kind: 'public'; rateLimited: boolean };

/** Whether `/docs` is served. Off unless explicitly enabled, so production does not list its routes. */
export function isOpenApiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPENAPI_ENABLED === 'true';
}

/**
 * Serves Swagger UI at `/docs` and the spec at `/docs/openapi.json` when `OPENAPI_ENABLED=true`.
 * Call before `app.init()`/`listen()`: the routes go straight onto the HTTP adapter (outside Nest's
 * router and guards), and Express's not-found handler is registered at init.
 */
export function setupOpenApi(app: INestApplication, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isOpenApiEnabled(env)) return false;
  SwaggerModule.setup(OPENAPI_DOCS_PATH, app, buildOpenApiDocument(app), {
    jsonDocumentUrl: OPENAPI_JSON_PATH,
    raw: ['json'],
  });
  return true;
}

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('OctaP Core API')
    .setDescription(
      [
        'REST API of octap-core. Three kinds of caller:',
        '',
        '- **Merchant backend**: `Authorization: Bearer <api key>`. Send `X-Organization-Id` to have the',
        '  key checked against the organization you expect. Some routes also need a signed request.',
        '- **Console user**: `Authorization: Bearer <Google ID token>` from the console sign-in.',
        '- **Customer device**: public routes with no credential, rate limited per client IP.',
        '',
        'Each operation lists its auth, required scopes and limits in its description and in the',
        '`x-octap-auth` extension. Errors use the shared `ErrorResponse` shape.',
      ].join('\n'),
    )
    .setVersion('v1')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', description: 'Merchant API key, issued per organization.' },
      SECURITY_SCHEMES.apiKey,
    )
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', description: 'Google ID token of a signed-in console user.' },
      SECURITY_SCHEMES.consoleSession,
    )
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: 'X-OctaP-Timestamp',
        description: 'Unix seconds; must be within the replay window.',
      },
      SECURITY_SCHEMES.signedTimestamp,
    )
    .addApiKey(
      { type: 'apiKey', in: 'header', name: 'X-OctaP-Nonce', description: 'Unique per request; reuse is rejected.' },
      SECURITY_SCHEMES.signedNonce,
    )
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: 'X-OctaP-Signature',
        description: 'HMAC of the request, keyed by the API key. See the SDK for the exact canonical string.',
      },
      SECURITY_SCHEMES.signedSignature,
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  annotateOperations(document, collectControllers(app));
  return document;
}

function collectControllers(app: INestApplication): Map<string, Type> {
  const controllers = new Map<string, Type>();
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const metatype = wrapper.metatype as Type | undefined;
      if (metatype) controllers.set(metatype.name, metatype);
    }
  }
  return controllers;
}

export function routeAccess(controller: Type, handler: (...args: never[]) => unknown): RouteAccess {
  const read = <T>(key: string): T | undefined =>
    (Reflect.getMetadata(key, handler) as T | undefined) ?? (Reflect.getMetadata(key, controller) as T | undefined);
  const guards = [
    ...((Reflect.getMetadata(GUARDS_METADATA, controller) as unknown[] | undefined) ?? []),
    ...((Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[] | undefined) ?? []),
  ];
  if (!read<boolean>(IS_PUBLIC_KEY)) {
    return {
      kind: 'apiKey',
      scopes: read<string[]>(SCOPES_KEY) ?? [],
      signed: read<boolean>(REQUIRE_SIGNED_REQUEST_KEY) ?? false,
    };
  }
  if (guards.includes(ConsoleAccessGuard)) {
    return { kind: 'console', platformAdminOnly: read<boolean>(PLATFORM_ADMIN_ONLY_KEY) ?? false };
  }
  return { kind: 'public', rateLimited: guards.includes(PublicRateLimitGuard) };
}

function annotateOperations(document: OpenAPIObject, controllers: Map<string, Type>): void {
  const components = (document.components ??= {});
  components.schemas = { ...components.schemas, ErrorResponse: ERROR_RESPONSE_SCHEMA };
  components.parameters = { ...components.parameters, OrganizationIdHeader: ORGANIZATION_ID_HEADER };
  const tags = new Set<string>();

  for (const item of Object.values(document.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (!operation) continue;
      const [controllerName, handlerName] = (operation.operationId ?? '').split('_', 2);
      const controller = controllers.get(controllerName);
      const handler = controller?.prototype[handlerName] as ((...args: never[]) => unknown) | undefined;
      if (!controller || !handler) throw new Error(`OpenAPI: no handler found for operation ${operation.operationId}`);

      let access = routeAccess(controller, handler);
      // A public route that reads `Authorization` itself (e.g. GET /v1/console/me) is a console route.
      if (access.kind === 'public' && dropAuthorizationHeader(operation)) {
        access = { kind: 'console', platformAdminOnly: false };
      }

      const tag = tagFor(controllerName);
      operation.tags = [tag];
      tags.add(tag);
      applyAccess(operation, access);
      for (const response of Object.values(operation.responses)) {
        if (response && 'description' in response && !response.description) response.description = 'Success.';
      }
      operation.responses['4XX'] ??= {
        description: 'Request rejected. `message` says why.',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
      };
    }
  }
  document.tags = [...tags].sort().map((name) => ({ name }));
}

/** OpenAPI allows `x-` vendor extensions on any object; swagger's type does not declare them. */
type ExtensibleOperation = OperationObject & { 'x-octap-auth'?: Record<string, unknown> };

function applyAccess(operation: ExtensibleOperation, access: RouteAccess): void {
  const notes: string[] = [];
  if (access.kind === 'apiKey') {
    operation.security = [
      access.signed
        ? {
            [SECURITY_SCHEMES.apiKey]: [],
            [SECURITY_SCHEMES.signedTimestamp]: [],
            [SECURITY_SCHEMES.signedNonce]: [],
            [SECURITY_SCHEMES.signedSignature]: [],
          }
        : { [SECURITY_SCHEMES.apiKey]: [] },
    ];
    operation.parameters = [...(operation.parameters ?? []), { $ref: '#/components/parameters/OrganizationIdHeader' }];
    notes.push(`**Auth:** merchant API key${access.signed ? ' + signed request' : ''}.`);
    if (access.scopes.length) notes.push(`**Required scopes:** ${access.scopes.map((s) => `\`${s}\``).join(', ')}.`);
    operation['x-octap-auth'] = { kind: 'apiKey', scopes: access.scopes, signedRequest: access.signed };
  } else if (access.kind === 'console') {
    operation.security = [{ [SECURITY_SCHEMES.consoleSession]: [] }];
    notes.push(`**Auth:** console user (Google ID token)${access.platformAdminOnly ? ', System Admin only' : ''}.`);
    operation['x-octap-auth'] = { kind: 'console', platformAdminOnly: access.platformAdminOnly };
  } else {
    operation.security = [];
    notes.push(`**Auth:** none (public)${access.rateLimited ? ', rate limited per client IP' : ''}.`);
    operation['x-octap-auth'] = { kind: 'public', rateLimited: access.rateLimited };
  }
  operation.description = [operation.description, notes.join('\n\n')].filter(Boolean).join('\n\n');
}

function dropAuthorizationHeader(operation: OperationObject): boolean {
  const isAuthorization = (p: ParameterObject | ReferenceObject) =>
    'in' in p && p.in === 'header' && p.name.toLowerCase() === 'authorization';
  const before = operation.parameters?.length ?? 0;
  operation.parameters = operation.parameters?.filter((p) => !isAuthorization(p));
  return (operation.parameters?.length ?? 0) < before;
}

/** `ConsoleOrganizationsController` → `Console Organizations`. */
export function tagFor(controllerName: string): string {
  return controllerName
    .replace(/Controller$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
}

/** Nest's built-in exception body; the app has no custom exception filter. */
const ERROR_RESPONSE_SCHEMA = {
  type: 'object' as const,
  required: ['statusCode', 'message'],
  properties: {
    statusCode: { type: 'integer' as const, example: 400 },
    message: {
      oneOf: [{ type: 'string' as const }, { type: 'array' as const, items: { type: 'string' as const } }],
      example: 'idempotencyKey is required',
    },
    error: { type: 'string' as const, example: 'Bad Request' },
  },
};

const ORGANIZATION_ID_HEADER: ParameterObject = {
  name: 'X-Organization-Id',
  in: 'header',
  required: false,
  description: 'Optional. When sent, the request is rejected (403) unless the API key belongs to this organization.',
  schema: { type: 'string', format: 'uuid' },
};
