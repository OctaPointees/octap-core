import { Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Req, Res, UseGuards } from '@nestjs/common';
import { ConsoleEventStreamService } from '#domain/events/console-event-stream.service.js';
import { Public } from '#infra/auth/public.decorator.js';
import { ConsoleAccessGuard, type ConsoleRequest } from './console-access.guard.js';
import { EventStream } from './event-stream.decorator.js';

/** The part of Express's request and response a stream needs. */
interface StreamRequest extends ConsoleRequest {
  headers: ConsoleRequest['headers'] & { 'last-event-id'?: string };
}
interface StreamResponse {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
  flushHeaders(): void;
  write(chunk: string): boolean;
  end(): void;
  /** The response's own `close`: the client went away. A GET request's `close` fires early. */
  on(event: 'close', listener: () => void): unknown;
}

/**
 * `GET /v1/console/organizations/:organizationId/events`: Server-Sent Events of what happens to the
 * organization, for the console to refetch what changed (OCT-326). Send the Google ID token as
 * `Authorization: Bearer`, so the client is a `fetch`-based SSE reader, not `EventSource` (which
 * cannot send headers). See `ConsoleEventStreamService` and `@octap/contracts`' `OrganizationStreamEvent`.
 */
@Public()
@UseGuards(ConsoleAccessGuard)
@Controller('v1/console/organizations/:organizationId/events')
export class ConsoleEventsController {
  constructor(private readonly events: ConsoleEventStreamService) {}

  @Get()
  @EventStream({
    description:
      'Server-Sent Events. Each message: `id` is the event `sequence`, `event` its type, `data` an ' +
      '`OrganizationStreamEvent` (`@octap/contracts`) as JSON. `stream.*` messages are about the ' +
      'stream itself. Send `Last-Event-ID` to resume.',
    resumable: true,
  })
  async stream(
    @Req() req: StreamRequest,
    @Res() res: StreamResponse,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ): Promise<void> {
    // An MCP token answers one request at a time; it never holds a connection open.
    if (req.mcpToken) throw new ForbiddenException('MCP access cannot open the event stream');
    const stream = await this.events.open({
      userId: req.consoleIdentity.user.id,
      organizationId,
      tokenExpiresAt: new Date(req.consoleIdentity.expiresAt),
      // Read here, not with `@Headers()`: the header is optional, and only a resuming client sends it.
      lastEventId: req.headers['last-event-id'],
    });
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // nginx and similar proxies buffer responses unless told not to.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    await stream.attach({
      write: (chunk) => void res.write(chunk),
      end: () => res.end(),
      onClose: (listener) => void res.on('close', listener),
    });
  }
}
