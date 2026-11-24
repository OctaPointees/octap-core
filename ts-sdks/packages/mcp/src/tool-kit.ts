import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import { OctaApiError } from '@octap/sdk';
import * as z from 'zod/v4';

export const REQUEST_TIMEOUT_MS = 12_000;

export type ToolExtra = ServerContext & { signal?: AbortSignal };

/** Read-only tools: they never change anything, and they reach Core (outside this process). */
export const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

export function isOctaApiError(err: unknown): err is OctaApiError {
  if (err instanceof OctaApiError) return true;
  if (err !== null && typeof err === 'object') {
    const candidate = err as Record<string, unknown>;
    return typeof candidate.statusCode === 'number' && candidate.name === 'OctaApiError';
  }
  return false;
}

/** Thrown when a tool that reads "the signed-in member" has no member bound to the request. */
export class MemberBindingError extends Error {
  constructor() {
    super('No authenticated member is bound to this request.');
    this.name = 'MemberBindingError';
  }
}

function errorResult(text: string) {
  return { isError: true as const, content: [{ type: 'text' as const, text }] };
}

/**
 * A bounded, model-safe error: the status decides the message, never Core's body or the request.
 * `notFound` names what a 404 means for this tool ("No voucher with this id…").
 */
export function safeError(tool: string, error: unknown, notFound?: string) {
  if (error instanceof MemberBindingError) {
    console.error(JSON.stringify({ event: 'mcp_member_binding_failed' }));
    return errorResult(error.message);
  }
  if (isOctaApiError(error)) {
    console.error(JSON.stringify({ event: 'core_api_error', tool, status: error.statusCode }));
    const message =
      error.statusCode === 401 || error.statusCode === 403
        ? 'Core denied this read. The signed-in role or the configured credential is not allowed to read this.'
        : error.statusCode === 404
          ? (notFound ?? 'No matching member or resource was found in the configured organization.')
          : error.statusCode === 429
            ? 'Rate limited; do not retry this call in this turn.'
            : error.statusCode >= 500
              ? 'Core is temporarily unavailable; do not retry this call in this turn.'
              : 'Core rejected this request. Check the tool inputs.';
    return errorResult(message);
  }

  // Do not serialize arbitrary errors: SDK/network errors may contain sensitive request details.
  console.error(JSON.stringify({ event: 'core_request_failed', tool }));
  return errorResult('Core could not complete this read. Check the local server logs.');
}

/**
 * A tool's answer: JSON text for every host, and the same value as structured content when the tool
 * declares an output schema (`structured`).
 */
export function result(tool: string, value: unknown, structured = false) {
  console.error(JSON.stringify({ event: 'mcp_tool_result', tool, outcome: 'success' }));
  const content = [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }];
  return structured ? { content, structuredContent: value as Record<string, unknown> } : { content };
}

export function combineSignal(extra?: Pick<ToolExtra, 'signal' | 'mcpReq'>): AbortSignal {
  const hostSignal = extra?.signal ?? extra?.mcpReq?.signal;
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return hostSignal ? AbortSignal.any([hostSignal, timeoutSignal]) : timeoutSignal;
}

/** Rewrites a tool's value before it is returned (`CreateServerOptions.project`). */
export type Projection<Name extends string> = (tool: Name, value: unknown) => unknown;

export interface ReadTool<Args, Value extends Record<string, unknown>> {
  description: string;
  input: z.ZodType<Args>;
  /** Declared to the host and checked by the SDK, unless a projection rewrites the value. */
  output: z.ZodObject;
  /** What a 404 means for this tool. */
  notFound?: string;
  run: (args: Args, signal: AbortSignal, extra: ToolExtra) => Promise<Value>;
}

/**
 * Registers a read-only tool. Every value is built from whitelisted fields by the tool itself, so
 * nothing Core adds later reaches the model unreviewed. With a projection (`project`), the value it
 * returns may have any shape, so no output schema is declared then.
 */
export function registerRead<Name extends string, Args, Value extends Record<string, unknown>>(
  server: McpServer,
  name: Name,
  tool: ReadTool<Args, Value>,
  project?: Projection<Name>,
) {
  server.registerTool(
    name,
    {
      description: tool.description,
      inputSchema: tool.input,
      ...(project ? {} : { outputSchema: tool.output }),
      annotations: READ_ONLY,
    },
    async (args: Args, extra: ToolExtra) => {
      try {
        const value = await tool.run(args, combineSignal(extra), extra);
        return project ? result(name, project(name, value)) : result(name, value, true);
      } catch (error) {
        return safeError(name, error, tool.notFound);
      }
    },
  );
}

/** `value ?? null`, so a field Core leaves out is `null` in the answer rather than missing. */
export const orNull = <T>(value: T | undefined | null): T | null => value ?? null;

export const nullableString = z.string().nullable();
export const nullableNumber = z.number().nullable();
/** Points and money: a number, or a decimal string where Core or an older client sends one. */
export const nullableAmount = z.union([z.number(), z.string()]).nullable();
