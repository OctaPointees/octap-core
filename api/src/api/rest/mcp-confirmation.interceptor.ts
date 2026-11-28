import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { from, mergeMap, of, type Observable } from 'rxjs';
import { McpConfirmationService } from '#domain/mcp-auth/mcp-confirmation.service.js';
import type { ConsoleRequest } from './console-access.guard.js';

/**
 * The second half of a confirmed MCP write (OCT-314); `ConsoleAccessGuard` did the first. A retry of a
 * change already made gets its first answer without running the handler again; a new change runs once
 * and its answer is kept for such a retry. A Google console request passes through untouched.
 */
@Injectable()
export class McpConfirmationInterceptor implements NestInterceptor {
  constructor(private readonly confirmations: McpConfirmationService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<ConsoleRequest>();
    const outcome = request.mcpConfirmation;
    if (!outcome || !request.mcpToken) return next.handle();
    if (outcome.kind === 'replay') return of(outcome.body);
    const token = request.mcpToken;
    const write = { method: request.method ?? '', path: request.path ?? '', body: request.body };
    return next
      .handle()
      .pipe(
        mergeMap((body: unknown) =>
          from(this.confirmations.storeResult(token, write, outcome.id, body).then(() => body)),
        ),
      );
  }
}
