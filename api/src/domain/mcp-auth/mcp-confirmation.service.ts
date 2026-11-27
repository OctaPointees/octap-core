import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { McpConfirmation, McpTokenIntrospection } from '@octap/contracts';
import { REDIS_CLIENT } from '#infra/cache/redis.provider.js';

/** The header an MCP host's write carries: the confirmation it applies. */
export const MCP_CONFIRMATION_HEADER = 'x-mcp-confirmation';
/** How long a prepared change waits for the user to confirm it. */
export const CONFIRMATION_TTL_SECONDS = 300;
/** How long a retry with the same confirmation gets the first answer back. */
export const RESULT_TTL_SECONDS = 600;
const WRITE_METHODS = ['POST', 'PATCH', 'PUT', 'DELETE'] as const;
const MAX_BODY_LENGTH = 16_384;
const MAX_SUMMARY_LENGTH = 1_000;

/** The request a write is checked against: what the guard sees. */
export interface McpWriteRequest {
  method: string;
  path: string;
  body: unknown;
}

/** What the guard decided: apply the change once, or answer a retry with the first result. */
export type McpConfirmationOutcome = { kind: 'apply'; id: string } | { kind: 'replay'; body: unknown };

interface Binding {
  userId: string;
  organizationId: string;
  clientId: string;
}

interface PendingRecord extends Binding {
  method: string;
  path: string;
  /** The body as JSON text, exactly as prepared. */
  body: string;
  summary: string;
  expiresAt: number;
}

interface ResultRecord extends Binding {
  method: string;
  path: string;
  body: string;
  result: unknown;
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const bodyText = (body: unknown) => JSON.stringify(body ?? {});

/**
 * Confirmed writes for MCP hosts (OCT-314). A host prepares a change (`prepare`): Core stores the exact
 * request, bound to the user, organization and MCP client, and returns an id plus the summary to show
 * the user. Only once the user agrees does the host send that request with the id
 * (`X-Mcp-Confirmation`). The console guard consumes the id (`consume`): it works once, for that
 * request only, within 5 minutes.
 *
 * The id is also the idempotency key. After the change, its answer is kept for 10 minutes
 * (`storeResult`), so a retry of the same request returns the same answer instead of making the change
 * again. Everything lives in Redis under hashed keys with its TTL.
 */
@Injectable()
export class McpConfirmationService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** Stores a change to confirm. The route checks nothing else: the write itself is checked when applied. */
  async prepare(token: McpTokenIntrospection, organizationId: string, input: unknown): Promise<McpConfirmation> {
    const body = (input ?? {}) as Record<string, unknown>;
    const method = typeof body.method === 'string' ? body.method.toUpperCase() : '';
    if (!(WRITE_METHODS as readonly string[]).includes(method))
      throw new BadRequestException(`method must be one of ${WRITE_METHODS.join(', ')}`);
    const prefix = `/v1/console/organizations/${organizationId}/`;
    const path = body.path;
    if (
      typeof path !== 'string' ||
      path.length > 500 ||
      !path.startsWith(prefix) ||
      !/^[A-Za-z0-9/_-]+$/.test(path.slice(prefix.length))
    )
      throw new BadRequestException(`path must be a console route of this organization (${prefix}...)`);
    const requestBody = body.body ?? {};
    if (typeof requestBody !== 'object' || requestBody === null || Array.isArray(requestBody))
      throw new BadRequestException('body must be a JSON object');
    const text = bodyText(requestBody);
    if (text.length > MAX_BODY_LENGTH) throw new BadRequestException('body is too large');
    const summary = typeof body.summary === 'string' ? body.summary.trim() : '';
    if (!summary || summary.length > MAX_SUMMARY_LENGTH)
      throw new BadRequestException(`summary must be 1-${MAX_SUMMARY_LENGTH} characters`);

    const id = randomBytes(24).toString('base64url');
    const record: PendingRecord = {
      ...binding(token),
      method,
      path,
      body: text,
      summary,
      expiresAt: Math.floor(Date.now() / 1000) + CONFIRMATION_TTL_SECONDS,
    };
    await this.redis.set(this.key('pending', id), JSON.stringify(record), 'EX', CONFIRMATION_TTL_SECONDS);
    return view(id, record);
  }

  /** A pending change of this connection, for the host to show before applying it. */
  async get(token: McpTokenIntrospection, id: string): Promise<McpConfirmation> {
    const raw = await this.redis.get(this.key('pending', id));
    const record = raw ? (JSON.parse(raw) as PendingRecord) : null;
    if (!record || !sameBinding(record, token))
      throw new NotFoundException('No pending change with this id. It expired or was already made; prepare it again.');
    return view(id, record);
  }

  /**
   * Called by the console guard before an MCP write runs. Consumes the confirmation (once, even when
   * two requests race), or recognizes a retry of a change already made.
   */
  async consume(token: McpTokenIntrospection, request: McpWriteRequest, id: string): Promise<McpConfirmationOutcome> {
    const raw = await this.redis.getdel(this.key('pending', id));
    if (!raw) {
      const done = await this.redis.get(this.key('result', id));
      const result = done ? (JSON.parse(done) as ResultRecord) : null;
      if (result && sameBinding(result, token) && sameRequest(result, request))
        return { kind: 'replay', body: result.result };
      throw new ConflictException('This change was already made, or its confirmation expired. Prepare it again.');
    }
    const record = JSON.parse(raw) as PendingRecord;
    if (!sameBinding(record, token)) throw new ForbiddenException('This confirmation belongs to another connection.');
    if (!sameRequest(record, request))
      throw new ForbiddenException('This request is not the change that was confirmed. Prepare it again.');
    return { kind: 'apply', id };
  }

  /** Keeps a made change's answer, so a retry with the same confirmation gets it back. */
  async storeResult(token: McpTokenIntrospection, request: McpWriteRequest, id: string, result: unknown) {
    const record: ResultRecord = {
      ...binding(token),
      method: request.method.toUpperCase(),
      path: request.path,
      body: bodyText(request.body),
      result: result ?? null,
    };
    await this.redis.set(this.key('result', id), JSON.stringify(record), 'EX', RESULT_TTL_SECONDS);
  }

  private key(kind: 'pending' | 'result', id: string) {
    return `mcp-confirm:${kind}:${hash(id)}`;
  }
}

function binding(token: McpTokenIntrospection): Binding {
  return { userId: token.userId, organizationId: token.organizationId, clientId: token.clientId };
}

function sameBinding(record: Binding, token: McpTokenIntrospection) {
  return (
    record.userId === token.userId &&
    record.organizationId === token.organizationId &&
    record.clientId === token.clientId
  );
}

function sameRequest(record: { method: string; path: string; body: string }, request: McpWriteRequest) {
  return (
    record.method === request.method.toUpperCase() &&
    record.path === request.path &&
    record.body === bodyText(request.body)
  );
}

function view(id: string, record: PendingRecord): McpConfirmation {
  return {
    confirmationId: id,
    method: record.method as McpConfirmation['method'],
    path: record.path,
    body: JSON.parse(record.body) as Record<string, unknown>,
    summary: record.summary,
    expiresAt: new Date(record.expiresAt * 1000).toISOString(),
  };
}
