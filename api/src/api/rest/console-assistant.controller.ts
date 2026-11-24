import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { AssistantStreamEvent } from '@octap/contracts';
import { AssistantService } from '#domain/assistant/assistant.service.js';
import { Public } from '#infra/auth/public.decorator.js';
import { ConsoleAccessGuard, type ConsoleRequest } from './console-access.guard.js';
import type { AssistantMessageBodyDto } from '../dto/assistant.dto.js';

/** The part of Express's response a server-sent event stream needs. */
interface StreamResponse {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
  flushHeaders(): void;
  write(chunk: string): boolean;
  end(): void;
  on(event: 'close', listener: () => void): unknown;
  writableEnded: boolean;
}

/**
 * The dashboard assistant (OCT-308): Owner or Business Developer of the organization, signed in to
 * the console with Google. An MCP access token is refused: the assistant issues its own.
 */
@Public()
@UseGuards(ConsoleAccessGuard)
@Controller('v1/console/organizations/:organizationId/assistant')
export class ConsoleAssistantController {
  constructor(private readonly assistant: AssistantService) {}

  /**
   * Answers one message as a stream (`text/event-stream`) of `AssistantStreamEvent`s. Settings, body,
   * membership and rate-limit errors come back as plain JSON errors before the stream starts.
   *
   * The declared result is what each `data:` line of the stream holds, so OpenAPI documents the event
   * shape; the handler writes the stream itself and returns nothing.
   */
  @Post('messages')
  @HttpCode(200)
  async message(
    @Req() req: ConsoleRequest,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() body: AssistantMessageBodyDto,
    @Res() res: StreamResponse,
  ): Promise<AssistantStreamEvent | undefined> {
    if (req.mcpToken) throw new ForbiddenException('Sign in to the console to use the assistant');
    const turn = await this.assistant.prepare(req.consoleIdentity, organizationId, body);

    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Connection', 'keep-alive');
    // Proxies such as nginx would otherwise hold the stream until it ends.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const send = (event: AssistantStreamEvent) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    for await (const event of this.assistant.stream(turn, abort.signal)) send(event);
    res.end();
    return undefined;
  }
}
