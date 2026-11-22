import { createServer as createNodeServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import {
  OAuthError,
  OAuthErrorCode,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  oauthMetadataResponse,
  requireBearerAuth,
  type AuthInfo,
  type AuthMetadataOptions,
  type OAuthMetadata,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import { consoleCoreClient, introspectToken } from './console-client.js';
import { instructionsForPersona, toolsForPersona } from './personas.js';
import { createServer, type CreateServerOptions } from './server.js';

export const MCP_PATH = '/mcp';
const TOKEN_CHECK_TIMEOUT_MS = 10_000;

export interface HttpServerOptions {
  /** Core's base URL, which is also the OAuth authorization server. */
  apiUrl: string;
  /** This server's public URL, e.g. `https://mcp.octap.example`. The MCP endpoint is `<publicUrl>/mcp`. */
  publicUrl: string;
  /** Core's RFC 8414 metadata. Fetched from Core when omitted. */
  oauthMetadata?: OAuthMetadata;
  /**
   * Options passed to every per-request `createServer` call, except the Core client and the
   * instructions. `tools` can only narrow the persona's tool set, never widen it.
   */
  server?: Omit<CreateServerOptions, 'client' | 'instructions'>;
}

/** The token facts the tools need, carried in `AuthInfo.extra`. */
export interface OctapAuthExtra extends Record<string, unknown> {
  organizationId: string;
  persona: string;
  userId: string;
}

/** Verifies every bearer token with Core. A token Core refuses is `invalid_token` (401 with a challenge). */
export function coreTokenVerifier(apiUrl: string): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const introspection = await introspectToken(apiUrl, token, AbortSignal.timeout(TOKEN_CHECK_TIMEOUT_MS));
      if (!introspection) throw new OAuthError(OAuthErrorCode.InvalidToken, 'The access token is invalid or expired');
      const extra: OctapAuthExtra = {
        organizationId: introspection.organizationId,
        persona: introspection.persona,
        userId: introspection.userId,
      };
      return {
        token,
        clientId: introspection.clientId,
        scopes: introspection.scopes,
        expiresAt: introspection.expiresAt,
        resource: new URL(introspection.resource),
        extra,
      };
    },
  };
}

export async function fetchAuthorizationServerMetadata(apiUrl: string): Promise<OAuthMetadata> {
  const response = await fetch(`${apiUrl.replace(/\/+$/, '')}/.well-known/oauth-authorization-server`, {
    signal: AbortSignal.timeout(TOKEN_CHECK_TIMEOUT_MS),
  });
  if (!response.ok)
    throw new Error(`Core did not publish OAuth metadata (status ${response.status}). Is MCP sign-in configured?`);
  return (await response.json()) as OAuthMetadata;
}

/**
 * The remote MCP endpoint as a web-standard `fetch` handler (OCT-293). Serves the RFC 9728 protected
 * resource metadata, requires a Core-issued bearer token on `/mcp` (audience-checked against this
 * server), and builds one MCP server per request with a Core client bound to that token. An MCP
 * session id is never authentication: each request is checked on its own.
 */
export async function createHttpHandler(options: HttpServerOptions) {
  const publicUrl = new URL(options.publicUrl);
  const resource = new URL(MCP_PATH, publicUrl);
  const oauthMetadata = options.oauthMetadata ?? (await fetchAuthorizationServerMetadata(options.apiUrl));
  const metadataOptions: AuthMetadataOptions = {
    oauthMetadata,
    resourceServerUrl: resource,
    resourceName: 'OctaP',
    scopesSupported: ['mcp'],
    dangerouslyAllowInsecureIssuerUrl: isLoopback(new URL(oauthMetadata.issuer)),
  };
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resource);
  const gate = requireBearerAuth({
    verifier: coreTokenVerifier(options.apiUrl),
    expectedResource: resource,
    resourceMetadataUrl,
  });
  const mcp = createMcpHandler(({ authInfo }) => {
    const extra = authInfo?.extra as OctapAuthExtra | undefined;
    // The gate ran first, so this only guards against wiring mistakes.
    if (!authInfo || !extra?.organizationId) throw new Error('Unauthenticated MCP request');
    // The persona comes from Core's token check, never from the request or the model (OCT-294).
    const personaTools = toolsForPersona(extra.persona);
    const narrowed = options.server?.tools;
    return createServer({
      ...options.server,
      tools: narrowed ? personaTools.filter((tool) => narrowed.includes(tool)) : personaTools,
      instructions: instructionsForPersona(extra.persona),
      client: consoleCoreClient(options.apiUrl, authInfo.token, extra.organizationId),
    });
  });

  return async (request: Request): Promise<Response> => {
    // DNS-rebinding guard. The URL's host is the request's Host header (`toRequest` builds it from
    // that), which a web-standard Request does not expose as a header.
    if (new URL(request.url).hostname !== publicUrl.hostname)
      return Response.json({ error: 'invalid_host' }, { status: 403 });
    const metadata = oauthMetadataResponse(request, metadataOptions);
    if (metadata) return metadata;
    if (new URL(request.url).pathname !== MCP_PATH) return new Response('Not found', { status: 404 });
    const auth = await gate(request);
    if (auth instanceof Response) return auth;
    return mcp.fetch(request, { authInfo: auth });
  };
}

/** Serves a `fetch` handler on `node:http`, streaming responses (SSE) as they are produced. */
export function listen(handler: (request: Request) => Promise<Response>, port: number, host: string) {
  const server = createNodeServer((req, res) => {
    void toRequest(req)
      .then(handler)
      .then((response) => writeResponse(response, res))
      .catch(() => {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'server_error' }));
      });
  });
  return new Promise<typeof server>((resolve) => server.listen(port, host, () => resolve(server)));
}

async function toRequest(req: IncomingMessage): Promise<Request> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const chunks: Buffer[] = [];
  if (hasBody) for await (const chunk of req) chunks.push(chunk as Buffer);
  const controller = new AbortController();
  req.socket.once('close', () => controller.abort());
  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? Buffer.concat(chunks) : undefined,
    signal: controller.signal,
  });
}

async function writeResponse(response: Response, res: ServerResponse) {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  if (!response.body) {
    res.end();
    return;
  }
  res.flushHeaders();
  const body = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
  res.on('close', () => body.destroy());
  body.pipe(res);
}

function isLoopback(url: URL) {
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}
