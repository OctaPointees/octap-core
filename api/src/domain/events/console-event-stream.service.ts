import {
  type BeforeApplicationShutdown,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  ORGANIZATION_STREAM_CONTROL,
  type OrganizationStreamControl,
  type OrganizationStreamEvent,
} from '@octap/contracts';
import { ConsoleAccessError } from '#infra/db/repositories/console-access.js';
import { ConsoleOrganizationsRepository } from '#infra/db/repositories/console-organizations.repository.js';
import { OrganizationEventsRepository } from '#infra/db/repositories/events.repository.js';
import { toStreamEvent } from './event-subjects.js';
import { OrganizationEventHub } from './organization-event-hub.js';
import { sseControl, sseEvent, sseHeartbeat, sseRetry } from './sse.js';

const HEARTBEAT_MS = Number(process.env.CONSOLE_EVENTS_HEARTBEAT_MS ?? 20_000);
/** Streams one user may hold open on one instance (several tabs, a reconnect racing the old one). */
export const MAX_STREAMS_PER_USER = 5;
/** More events than this since a `Last-Event-ID` and the stream says `stream.reset` instead of replaying. */
export const REPLAY_LIMIT = 1000;

/** Where a stream writes: the HTTP response, or a fake in tests. */
export interface StreamSink {
  write(chunk: string): void;
  end(): void;
  /** Called once when the client goes away. */
  onClose(listener: () => void): void;
}

export interface OpenStreamParams {
  userId: string;
  organizationId: string;
  /** When the Google ID token the stream was opened with expires: the stream closes then. */
  tokenExpiresAt: Date;
  /** The `Last-Event-ID` header, if the client is resuming. */
  lastEventId?: string;
}

/**
 * The console event stream (OCT-326): an active Owner or Business Developer of an active organization
 * follows what happens to it, as thin messages (`OrganizationStreamEvent`) that say what to refetch.
 * `open` runs every check before a byte is sent, so a refusal is an ordinary 403 or 429. `attach` then
 * replays what a resuming client missed and streams new events from `OrganizationEventHub`. While
 * open, a heartbeat keeps proxies from closing the connection and checks access again: a member who
 * loses it gets `stream.access_revoked`. The stream also closes when its token expires
 * (`stream.token_expired`), so a client always reconnects with a valid one.
 */
@Injectable()
export class ConsoleEventStreamService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(ConsoleEventStreamService.name);
  private readonly openByUser = new Map<string, number>();
  /** How to close each open stream, for shutdown. */
  private readonly closers = new Set<() => void>();

  constructor(
    private readonly organizations: ConsoleOrganizationsRepository,
    private readonly events: OrganizationEventsRepository,
    private readonly hub: OrganizationEventHub,
  ) {}

  async open(params: OpenStreamParams): Promise<{ attach: (sink: StreamSink) => Promise<void> }> {
    if (!(await this.hasAccess(params.userId, params.organizationId))) throw new ForbiddenException(DENIED);
    if ((this.openByUser.get(params.userId) ?? 0) >= MAX_STREAMS_PER_USER)
      throw new HttpException(
        `At most ${MAX_STREAMS_PER_USER} event streams can be open at once; close one first`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    return { attach: (sink) => this.attach(params, sink) };
  }

  private async attach(params: OpenStreamParams, sink: StreamSink): Promise<void> {
    const { userId, organizationId } = params;
    this.openByUser.set(userId, (this.openByUser.get(userId) ?? 0) + 1);
    let open = true;
    let live = false;
    const sent = new Set<number>();
    const waiting: OrganizationStreamEvent[] = [];
    const send = (event: OrganizationStreamEvent) => {
      if (!open || sent.has(event.sequence)) return;
      sent.add(event.sequence);
      sink.write(sseEvent(event));
    };
    // Listen before replaying, so nothing committed in between is missed; `sent` drops the overlap.
    const unsubscribe = this.hub.subscribe(organizationId, (event) => (live ? send(event) : waiting.push(event)));
    const timers: { heartbeat?: NodeJS.Timeout; expiry?: NodeJS.Timeout } = {};
    const close = (control?: OrganizationStreamControl) => {
      if (!open) return;
      open = false;
      this.closers.delete(close);
      clearInterval(timers.heartbeat);
      clearTimeout(timers.expiry);
      unsubscribe();
      const remaining = (this.openByUser.get(userId) ?? 1) - 1;
      if (remaining > 0) this.openByUser.set(userId, remaining);
      else this.openByUser.delete(userId);
      if (control) sink.write(sseControl(control));
      sink.end();
    };
    sink.onClose(() => close());
    this.closers.add(close);

    sink.write(sseRetry());
    try {
      await this.replay(organizationId, params.lastEventId, sink, send);
    } catch (error: unknown) {
      this.logger.error(`replay failed: ${error instanceof Error ? error.message : String(error)}`);
      close();
      return;
    }
    live = true;
    for (const event of waiting.splice(0)) send(event);

    timers.heartbeat = setInterval(() => {
      if (!open) return;
      sink.write(sseHeartbeat());
      void this.hasAccess(userId, organizationId).then(
        (allowed) => {
          if (!allowed) close(ORGANIZATION_STREAM_CONTROL.accessRevoked);
        },
        // A failed check is not a revocation: try again on the next heartbeat.
        (error: unknown) =>
          this.logger.warn(`access check failed: ${error instanceof Error ? error.message : String(error)}`),
      );
    }, HEARTBEAT_MS);
    timers.expiry = setTimeout(
      () => close(ORGANIZATION_STREAM_CONTROL.tokenExpired),
      Math.max(0, params.tokenExpiresAt.getTime() - Date.now()),
    );
  }

  /**
   * Ends every open stream before the HTTP server closes, which would otherwise wait for them. Their
   * clients reconnect, to another instance or this one restarted, and resume with `Last-Event-ID`.
   */
  beforeApplicationShutdown(): void {
    for (const close of [...this.closers]) close();
  }

  /**
   * What a resuming client missed: the events after its `Last-Event-ID`, or `stream.reset` when that
   * event is gone (trimmed after 30 days), was never this organization's, or is too far back to replay.
   */
  private async replay(
    organizationId: string,
    lastEventId: string | undefined,
    sink: StreamSink,
    send: (event: OrganizationStreamEvent) => void,
  ): Promise<void> {
    if (lastEventId === undefined || lastEventId === '') return;
    const after = /^\d{1,15}$/.test(lastEventId) ? Number(lastEventId) : null;
    if (after === null || !(await this.events.hasEvent(organizationId, after))) {
      sink.write(sseControl(ORGANIZATION_STREAM_CONTROL.reset));
      return;
    }
    const rows = await this.events.replaySince(organizationId, after, REPLAY_LIMIT + 1);
    if (rows.length > REPLAY_LIMIT) {
      sink.write(sseControl(ORGANIZATION_STREAM_CONTROL.reset));
      return;
    }
    for (const row of rows) {
      const event = toStreamEvent(row);
      if (event) send(event);
    }
  }

  /** An active Owner or Business Developer of an active organization. */
  private async hasAccess(userId: string, organizationId: string): Promise<boolean> {
    try {
      await this.organizations.withAccess(userId, organizationId, false, async () => undefined);
      return true;
    } catch (error) {
      if (error instanceof ConsoleAccessError) return false;
      throw error;
    }
  }
}

const DENIED = 'Only an active Owner or Business Developer of an active organization can follow its events';
