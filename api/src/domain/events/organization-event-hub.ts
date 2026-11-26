import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { OrganizationStreamEvent } from '@octap/contracts';
import { OrganizationEventsRepository, type OrganizationEvent } from '#infra/db/repositories/events.repository.js';
import { toStreamEvent } from './event-subjects.js';
import { outsideRequestContext } from '#observability/request-context.js';

const POLL_INTERVAL_MS = Number(process.env.CONSOLE_EVENTS_POLL_INTERVAL_MS ?? 1000);
/**
 * How long an event may take between being numbered (at insert) and becoming visible (at commit), and
 * still be streamed. `sequence` is assigned at insert, so an event can commit after a higher one: each
 * scan reads again from the highest sequence seen at least this long ago, and skips what it sent.
 */
export const LATE_COMMIT_WINDOW_MS = 60_000;
const SCAN_LIMIT = 1000;

export type OrganizationEventListener = (event: OrganizationStreamEvent) => void;

/**
 * Every console stream open on this instance listens here. While at least one is open, one loop polls
 * `organization_events` for the organizations being listened to, about once a second, and hands each
 * new event to that organization's listeners. One query per instance, however many streams are open.
 * Only committed events are read, so a stream never announces a change that rolled back, and events
 * written by the worker process arrive the same way. An event can reach a listener more than once, or
 * one from just before it connected: a stream message is only a hint to refetch.
 */
@Injectable()
export class OrganizationEventHub implements OnModuleDestroy {
  private readonly logger = new Logger(OrganizationEventHub.name);
  private readonly listeners = new Map<string, Set<OrganizationEventListener>>();
  private timer?: NodeJS.Timeout;
  private polling = false;
  /** Scans read after this sequence. Everything at or below it is settled. */
  private floor: number | null = null;
  /** Sequences above `floor` already handed out. */
  private readonly sent = new Set<number>();
  /** The highest sequence seen at each scan, to move `floor` once the window has passed. */
  private samples: { at: number; highest: number }[] = [];

  constructor(private readonly events: OrganizationEventsRepository) {}

  /** Starts listening to `organizationId`. Call the returned function to stop. */
  subscribe(organizationId: string, listener: OrganizationEventListener): () => void {
    let set = this.listeners.get(organizationId);
    if (!set) {
      set = new Set();
      this.listeners.set(organizationId, set);
    }
    set.add(listener);
    // Started by the first stream's request: outside its context, so the poll never acts as that user.
    this.timer ??= outsideRequestContext(() => setInterval(() => void this.pollOnce(), POLL_INTERVAL_MS));
    return () => {
      const current = this.listeners.get(organizationId);
      current?.delete(listener);
      if (current?.size === 0) this.listeners.delete(organizationId);
      if (this.listeners.size === 0) this.stop();
    };
  }

  onModuleDestroy(): void {
    this.stop();
  }

  /** One scan. Public for tests; the interval calls it. */
  async pollOnce(now = Date.now()): Promise<void> {
    if (this.polling || this.listeners.size === 0) return;
    this.polling = true;
    try {
      // The first scan starts from now: a stream replays what it missed itself (`Last-Event-ID`).
      this.floor ??= await this.events.latestSequence();
      const organizationIds = [...this.listeners.keys()];
      let highest = this.floor;
      // Page through: a busy window can hold more than one page of events already sent.
      for (let after = this.floor; ;) {
        const rows = await this.events.scanSince(organizationIds, after, SCAN_LIMIT);
        for (const row of rows) this.dispatch(row);
        if (rows.length > 0) after = highest = Math.max(highest, rows[rows.length - 1].sequence);
        if (rows.length < SCAN_LIMIT) break;
      }
      this.settle(now, Math.max(highest, this.samples.at(-1)?.highest ?? highest));
    } catch (error: unknown) {
      this.logger.error(`scan failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.polling = false;
    }
  }

  private dispatch(row: OrganizationEvent): void {
    if (this.sent.has(row.sequence)) return;
    this.sent.add(row.sequence);
    const event = toStreamEvent(row);
    if (!event) return;
    for (const listener of this.listeners.get(row.organizationId) ?? []) {
      try {
        listener(event);
      } catch (error: unknown) {
        // One broken stream must not stop the others from hearing about the event.
        this.logger.warn(`listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Moves `floor` to the highest sequence seen at least `LATE_COMMIT_WINDOW_MS` ago. */
  private settle(now: number, highest: number): void {
    this.samples.push({ at: now, highest });
    const cutoff = now - LATE_COMMIT_WINDOW_MS;
    let settled: number | null = null;
    while (this.samples.length > 1 && this.samples[0].at <= cutoff) {
      settled = this.samples.shift()!.highest;
    }
    if (settled === null || this.floor === null || settled <= this.floor) return;
    this.floor = settled;
    for (const sequence of this.sent) if (sequence <= settled) this.sent.delete(sequence);
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    // The next first stream starts afresh from the latest event.
    this.floor = null;
    this.sent.clear();
    this.samples = [];
  }
}
