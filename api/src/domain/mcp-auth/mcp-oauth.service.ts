import {
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { ConsoleIdentity, McpTokenIntrospection, OrganizationPersona } from '@octap/contracts';
import { REDIS_CLIENT } from '#infra/cache/redis.provider.js';
import { GoogleIdentityClient } from '#infra/clients/google/google-identity.client.js';
import {
  ConsoleUsersRepository,
  GoogleAccountLinkRequiredError,
} from '#infra/db/repositories/console-users.repository.js';

/** Every MCP access token starts with this, so the console guard can tell it from a Google ID token. */
export const MCP_TOKEN_PREFIX = 'octap_mcp_';
export const MCP_SCOPE = 'mcp';
export const AUTHORIZATION_REQUEST_TTL_SECONDS = 600;
export const AUTHORIZATION_CODE_TTL_SECONDS = 60;
export const ACCESS_TOKEN_TTL_SECONDS = 3600;
/** Long enough for one assistant turn; revoked as soon as the turn ends. */
export const ASSISTANT_TOKEN_TTL_SECONDS = 600;
/** The client id on assistant tokens, so they can be told apart from an MCP host's. */
export const ASSISTANT_CLIENT_ID = 'octap-dashboard-assistant';
const CLIENT_ID_PREFIX = 'mcpc_';
const MAX_REDIRECT_URIS = 5;
const MAX_URL_LENGTH = 2048;
const BLOCKED_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:']);

/** An OAuth error answered as `{ error, error_description }` JSON (RFC 6749 §5.2, RFC 7591 §3.2.2). */
export class OAuthProtocolError extends HttpException {
  constructor(error: string, description: string, status = 400) {
    super({ error, error_description: description }, status);
    // The body stays the OAuth JSON; the message is what logs and tests read.
    this.message = description;
  }
}

export interface RegisteredClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
}

export interface AuthorizationParams {
  response_type?: unknown;
  client_id?: unknown;
  redirect_uri?: unknown;
  code_challenge?: unknown;
  code_challenge_method?: unknown;
  state?: unknown;
  scope?: unknown;
  resource?: unknown;
}

/** What the sign-in page needs to show and to carry back. */
export interface PendingAuthorizationView {
  requestId: string;
  clientName: string;
  redirectHost: string;
  googleClientId: string;
}

export type AuthorizationStep =
  | { redirectTo: string }
  | { organizations: Array<{ organizationId: string; name: string; persona: OrganizationPersona }> };

interface PendingAuthorization {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  resource: string;
  /** Set once Google sign-in succeeded and the user still has to pick an organization. */
  userId?: string;
}

interface Grant {
  clientId: string;
  userId: string;
  organizationId: string;
  persona: OrganizationPersona;
  resource: string;
}

interface AuthorizationCodeRecord extends Grant {
  redirectUri: string;
  codeChallenge: string;
}

interface AccessTokenRecord extends Grant {
  expiresAt: number;
}

export interface McpAuthenticatedIdentity {
  identity: ConsoleIdentity;
  token: McpTokenIntrospection;
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');
const asString = (value: unknown) => (typeof value === 'string' && value.length > 0 ? value : undefined);

/**
 * OAuth 2.1 authorization server for MCP hosts (OCT-293): dynamic client registration, the
 * authorization-code flow with PKCE (S256 only) behind the console's Google sign-in, and short-lived
 * opaque access tokens bound to one user, one organization and that user's persona there.
 *
 * Client ids are self-contained and HMAC-signed, so registration needs no storage. Pending
 * authorizations, codes and tokens live in Redis under hashed keys with their TTL; a lost Redis only
 * means signing in again. A token is never a session: every use rechecks the membership.
 */
@Injectable()
export class McpOAuthService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly google: GoogleIdentityClient,
    private readonly users: ConsoleUsersRepository,
  ) {}

  /** RFC 8414 metadata. The issuer is the Core origin MCP hosts reach. */
  metadata() {
    const issuer = this.issuer();
    return {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [MCP_SCOPE],
    };
  }

  /** RFC 7591 registration of a public client. Nothing is stored: the client id carries its own redirect URIs. */
  register(body: unknown) {
    const input = (body ?? {}) as Record<string, unknown>;
    const redirectUris = input.redirect_uris;
    if (
      !Array.isArray(redirectUris) ||
      redirectUris.length === 0 ||
      redirectUris.length > MAX_REDIRECT_URIS ||
      !redirectUris.every((uri) => typeof uri === 'string' && isAllowedRedirectUri(uri))
    )
      throw new OAuthProtocolError(
        'invalid_redirect_uri',
        `redirect_uris must list 1-${MAX_REDIRECT_URIS} https, loopback http or app-scheme URLs without fragments`,
      );
    const method = input.token_endpoint_auth_method ?? 'none';
    if (method !== 'none')
      throw new OAuthProtocolError('invalid_client_metadata', 'Only public clients (token_endpoint_auth_method none)');
    const grantTypes = input.grant_types ?? ['authorization_code'];
    if (!Array.isArray(grantTypes) || !grantTypes.includes('authorization_code'))
      throw new OAuthProtocolError('invalid_client_metadata', 'grant_types must include authorization_code');
    const clientName =
      typeof input.client_name === 'string' && input.client_name.trim()
        ? input.client_name.trim().slice(0, 100)
        : 'MCP client';
    const payload = Buffer.from(JSON.stringify({ n: clientName, r: redirectUris })).toString('base64url');
    const clientId = `${CLIENT_ID_PREFIX}${payload}.${this.sign(payload)}`;
    return {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: clientName,
      redirect_uris: redirectUris as string[],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  /** Validates `GET /oauth/authorize` and holds it until the user signs in. */
  async startAuthorization(params: AuthorizationParams): Promise<PendingAuthorizationView> {
    const client = this.client(params.client_id);
    const redirectUri = asString(params.redirect_uri);
    if (!client || !redirectUri || !client.redirectUris.includes(redirectUri))
      throw new OAuthProtocolError('invalid_request', 'Unknown client_id or a redirect_uri it did not register');
    if (params.response_type !== 'code')
      throw new OAuthProtocolError('unsupported_response_type', 'response_type must be code');
    const codeChallenge = asString(params.code_challenge);
    if (!codeChallenge || !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge) || params.code_challenge_method !== 'S256')
      throw new OAuthProtocolError(
        'invalid_request',
        'PKCE is required: code_challenge with code_challenge_method S256',
      );
    const scope = asString(params.scope);
    if (scope && !scope.split(' ').every((value) => value === MCP_SCOPE))
      throw new OAuthProtocolError('invalid_scope', `Only the ${MCP_SCOPE} scope is supported`);
    // RFC 8707, required by the MCP spec: without it the token is bound to no MCP server, so any
    // server would accept it.
    const resource = asString(params.resource);
    if (!resource || !isHttpUrl(resource))
      throw new OAuthProtocolError(
        'invalid_target',
        'resource is required: the absolute http(s) URL of the MCP server',
      );
    const state = asString(params.state) ?? null;
    if (state && state.length > 1024) throw new OAuthProtocolError('invalid_request', 'state is too long');

    const requestId = random();
    const pending: PendingAuthorization = {
      clientId: client.clientId,
      redirectUri,
      codeChallenge,
      state,
      resource,
    };
    await this.redis.set(
      this.key('request', requestId),
      JSON.stringify(pending),
      'EX',
      AUTHORIZATION_REQUEST_TTL_SECONDS,
    );
    return {
      requestId,
      clientName: client.clientName,
      redirectHost: describeRedirect(redirectUri),
      googleClientId: this.googleClientId(),
    };
  }

  /**
   * The sign-in page posts the Google ID token here. The token must carry the request id as its
   * nonce, so a Google token minted for anything else (the console itself, another request) is refused.
   */
  async completeGoogleSignIn(requestId: unknown, credential: unknown): Promise<AuthorizationStep> {
    const id = asString(requestId);
    const pending = id ? await this.pending(id) : null;
    if (!id || !pending || pending.userId)
      throw new NotFoundException('This sign-in expired. Start again from your MCP client.');
    if (typeof credential !== 'string') throw new UnauthorizedException('A Google sign-in is required');
    const google = await this.google.verify(credential);
    if (!google.nonce || !safeEqual(google.nonce, id))
      throw new UnauthorizedException('This Google sign-in was not made for this request. Start again.');
    let user;
    try {
      user = await this.users.resolveGoogleUser(google);
    } catch (error) {
      if (error instanceof GoogleAccountLinkRequiredError)
        throw new ConflictException('An existing account requires administrator-assisted Google linking');
      throw error;
    }
    const organizations = await this.users.memberships(user.id);
    if (organizations.length === 0)
      throw new UnauthorizedException('This Google account is not an Owner or Developer of any active organization.');
    if (organizations.length === 1) return this.issueCode(id, pending, user.id, organizations[0]);
    await this.redis.set(
      this.key('request', id),
      JSON.stringify({ ...pending, userId: user.id }),
      'EX',
      AUTHORIZATION_REQUEST_TTL_SECONDS,
    );
    return {
      organizations: organizations.map(({ organizationId, name, persona }) => ({ organizationId, name, persona })),
    };
  }

  /** The user picked one of their organizations after signing in. */
  async chooseOrganization(requestId: unknown, organizationId: unknown): Promise<AuthorizationStep> {
    const id = asString(requestId);
    const pending = id ? await this.pending(id) : null;
    if (!id || !pending?.userId) throw new NotFoundException('This sign-in expired. Start again from your MCP client.');
    const organization = (await this.users.memberships(pending.userId)).find(
      (candidate) => candidate.organizationId === organizationId,
    );
    if (!organization) throw new UnauthorizedException('You are not an Owner or Developer of that organization.');
    return this.issueCode(id, pending, pending.userId, organization);
  }

  /** `POST /oauth/token`: exchanges a code once, checking client, redirect URI, PKCE and resource. */
  async exchangeCode(body: unknown) {
    const input = (body ?? {}) as Record<string, unknown>;
    if (input.grant_type !== 'authorization_code')
      throw new OAuthProtocolError('unsupported_grant_type', 'Only authorization_code is supported');
    const code = asString(input.code);
    const verifier = asString(input.code_verifier);
    if (!code || !verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier))
      throw new OAuthProtocolError('invalid_request', 'code and a valid code_verifier are required');
    // GETDEL: a code works once, even when two exchanges race.
    const raw = await this.redis.getdel(this.key('code', hash(code)));
    if (!raw)
      throw new OAuthProtocolError('invalid_grant', 'The authorization code is invalid, expired or already used');
    const record = JSON.parse(raw) as AuthorizationCodeRecord;
    const resource = asString(input.resource) ?? null;
    if (
      input.client_id !== record.clientId ||
      input.redirect_uri !== record.redirectUri ||
      !safeEqual(createHash('sha256').update(verifier).digest('base64url'), record.codeChallenge) ||
      (resource !== null && resource !== record.resource)
    )
      throw new OAuthProtocolError(
        'invalid_grant',
        'The code does not match this client, redirect_uri, verifier or resource',
      );

    const token = `${MCP_TOKEN_PREFIX}${random()}`;
    const expiresAt = Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS;
    const stored: AccessTokenRecord = {
      clientId: record.clientId,
      userId: record.userId,
      organizationId: record.organizationId,
      persona: record.persona,
      resource: record.resource,
      expiresAt,
    };
    await this.redis.set(this.key('token', hash(token)), JSON.stringify(stored), 'EX', ACCESS_TOKEN_TTL_SECONDS);
    return { access_token: token, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_SECONDS, scope: MCP_SCOPE };
  }

  /**
   * A token for the dashboard assistant (OCT-308), issued by Core itself instead of through the
   * browser flow. It is the same record as any MCP token, so introspection, the console guard and the
   * MCP server treat it the same way: one organization, the user's persona there, read-only, and
   * rechecked on every use. It lives only for one assistant turn.
   */
  async issueAssistantToken(grant: {
    userId: string;
    organizationId: string;
    persona: OrganizationPersona;
    resource: string;
  }): Promise<string> {
    const token = `${MCP_TOKEN_PREFIX}${random()}`;
    const stored: AccessTokenRecord = {
      ...grant,
      clientId: ASSISTANT_CLIENT_ID,
      expiresAt: Math.floor(Date.now() / 1000) + ASSISTANT_TOKEN_TTL_SECONDS,
    };
    await this.redis.set(this.key('token', hash(token)), JSON.stringify(stored), 'EX', ASSISTANT_TOKEN_TTL_SECONDS);
    return token;
  }

  /** RFC 7009: always succeeds, whether or not the token existed. */
  async revoke(body: unknown) {
    const token = asString((body as Record<string, unknown> | undefined)?.token);
    if (token?.startsWith(MCP_TOKEN_PREFIX)) await this.redis.del(this.key('token', hash(token)));
    return {};
  }

  /**
   * Resolves an MCP access token to the console identity it acts as. The identity lists only the
   * bound organization. A user who lost that membership or changed persona loses the token too.
   */
  async authenticate(token: string): Promise<McpAuthenticatedIdentity> {
    const raw = token.startsWith(MCP_TOKEN_PREFIX) ? await this.redis.get(this.key('token', hash(token))) : null;
    const record = raw ? (JSON.parse(raw) as AccessTokenRecord) : null;
    if (!record || record.expiresAt <= Math.floor(Date.now() / 1000))
      throw new UnauthorizedException('The MCP access token is invalid or expired. Sign in again.');
    const user = await this.users.findById(record.userId);
    const organization = user
      ? (await this.users.memberships(user.id)).find(
          (candidate) => candidate.organizationId === record.organizationId && candidate.persona === record.persona,
        )
      : undefined;
    if (!user || !organization) {
      await this.redis.del(this.key('token', hash(token)));
      throw new UnauthorizedException('Your access to this organization changed. Sign in again.');
    }
    return {
      identity: {
        user: {
          id: user.id,
          email: user.email,
          fullName: user.fullName,
          avatarUrl: user.avatarUrl,
          systemRole: user.systemRole,
        },
        organizations: [organization],
        expiresAt: new Date(record.expiresAt * 1000).toISOString(),
      },
      token: {
        active: true,
        clientId: record.clientId,
        scopes: [MCP_SCOPE],
        userId: user.id,
        organizationId: record.organizationId,
        persona: record.persona,
        resource: record.resource,
        expiresAt: record.expiresAt,
      },
    };
  }

  private async issueCode(
    requestId: string,
    pending: PendingAuthorization,
    userId: string,
    organization: ConsoleIdentity['organizations'][number],
  ): Promise<AuthorizationStep> {
    // Single use: a pending request issues at most one code.
    if ((await this.redis.del(this.key('request', requestId))) === 0)
      throw new NotFoundException('This sign-in expired. Start again from your MCP client.');
    const code = random();
    const record: AuthorizationCodeRecord = {
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      userId,
      organizationId: organization.organizationId,
      persona: organization.persona,
      resource: pending.resource,
    };
    await this.redis.set(this.key('code', hash(code)), JSON.stringify(record), 'EX', AUTHORIZATION_CODE_TTL_SECONDS);
    const redirect = new URL(pending.redirectUri);
    redirect.searchParams.set('code', code);
    if (pending.state) redirect.searchParams.set('state', pending.state);
    redirect.searchParams.set('iss', this.issuer());
    return { redirectTo: redirect.toString() };
  }

  private async pending(requestId: string): Promise<PendingAuthorization | null> {
    const raw = await this.redis.get(this.key('request', requestId));
    return raw ? (JSON.parse(raw) as PendingAuthorization) : null;
  }

  private client(clientId: unknown): RegisteredClient | null {
    const value = asString(clientId);
    if (!value?.startsWith(CLIENT_ID_PREFIX) || value.length > 8192) return null;
    const [payload, signature, extra] = value.slice(CLIENT_ID_PREFIX.length).split('.');
    if (!payload || !signature || extra !== undefined || !safeEqual(signature, this.sign(payload))) return null;
    try {
      const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { n: string; r: string[] };
      return { clientId: value, clientName: decoded.n, redirectUris: decoded.r };
    } catch {
      return null;
    }
  }

  private sign(payload: string) {
    return createHmac('sha256', this.signingKey()).update(`mcp-client:${payload}`).digest('base64url');
  }

  private key(kind: 'request' | 'code' | 'token', id: string) {
    return `mcp-oauth:${kind}:${id}`;
  }

  private issuer() {
    const issuer = process.env.MCP_OAUTH_ISSUER_URL?.trim().replace(/\/+$/, '');
    if (!issuer) throw new ServiceUnavailableException('MCP sign-in is not configured');
    return issuer;
  }

  private signingKey() {
    const key = process.env.MCP_OAUTH_SIGNING_KEY?.trim();
    if (!key) throw new ServiceUnavailableException('MCP sign-in is not configured');
    return Buffer.from(key, 'base64');
  }

  private googleClientId() {
    const clientId = process.env.CONSOLE_GOOGLE_CLIENT_ID?.trim();
    if (!clientId) throw new ServiceUnavailableException('Console Google sign-in is not configured');
    return clientId;
  }
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && value.length <= MAX_URL_LENGTH;
  } catch {
    return false;
  }
}

/** https anywhere, http only on loopback, or a native app's private scheme; never a fragment. */
export function isAllowedRedirectUri(value: string) {
  if (value.length > MAX_URL_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash || BLOCKED_SCHEMES.has(url.protocol)) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol);
}

function describeRedirect(redirectUri: string) {
  const url = new URL(redirectUri);
  return url.host || url.protocol.replace(/:$/, '');
}
