import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrganizationStreamEvent } from '@octap/contracts';
import {
  ConsoleEventStreamService,
  MAX_STREAMS_PER_USER,
  REPLAY_LIMIT,
  type StreamSink,
} from '#domain/events/console-event-stream.service.js';
import type { OrganizationEventHub, OrganizationEventListener } from '#domain/events/organization-event-hub.js';
import { ConsoleAccessError } from '#infra/db/repositories/console-access.js';
import type { ConsoleOrganizationsRepository } from '#infra/db/repositories/console-organizations.repository.js';
import type { OrganizationEvent, OrganizationEventsRepository } from '#infra/db/repositories/events.repository.js';
import { stub } from '../../../helpers/stub.js';

const row = (sequence: number): OrganizationEvent => ({
  id: `evt-${sequence}`,
  sequence,
  organizationId: 'org-1',
  type: 'voucher.paused',
  payload: { voucherId: `v-${sequence}`, batchId: null },
  createdAt: new Date('2026-11-25T10:00:00Z'),
});
const streamed = (sequence: number): OrganizationStreamEvent => ({
  id: `evt-${sequence}`,
  sequence,
  type: 'voucher.paused',
  subject: { kind: 'voucher', id: `v-${sequence}`, batchId: null },
  occurredAt: '2026-11-25T10:00:00.000Z',
});

function sink() {
  const chunks: string[] = [];
  let closeListener: (() => void) | undefined;
  const value: StreamSink & { ended: boolean } = {
    ended: false,
    write: (chunk) => void chunks.push(chunk),
    end: () => void (value.ended = true),
    onClose: (listener) => void (closeListener = listener),
  };
  return {
    sink: value,
    /** Event names and ids written, in order; heartbeats as `ping`. */
    frames: () =>
      chunks
        .join('')
        .split('\n\n')
        .filter(Boolean)
        .map((frame) => {
          if (frame.startsWith(':')) return 'ping';
          if (frame.startsWith('retry:')) return 'retry';
          const id = /^id: (\d+)$/m.exec(frame)?.[1];
          const name = /^event: (.+)$/m.exec(frame)![1];
          return id ? `${name}#${id}` : name;
        }),
    clientLeaves: () => closeListener?.(),
  };
}

function setup(options: { allowed?: boolean | (() => boolean); anchor?: boolean; replay?: OrganizationEvent[] } = {}) {
  const listeners = new Set<OrganizationEventListener>();
  const unsubscribed = vi.fn();
  const hub = stub<OrganizationEventHub>({
    subscribe: (_organizationId: string, listener: OrganizationEventListener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        unsubscribed();
      };
    },
  });
  const allowed = options.allowed ?? true;
  const withAccess = vi.fn(async () => {
    if (!(typeof allowed === 'function' ? allowed() : allowed)) throw new ConsoleAccessError();
  });
  const replaySince = vi.fn(async () => options.replay ?? []);
  const service = new ConsoleEventStreamService(
    stub<ConsoleOrganizationsRepository>({ withAccess }),
    stub<OrganizationEventsRepository>({ hasEvent: async () => options.anchor ?? true, replaySince }),
    hub,
  );
  const publish = (event: OrganizationStreamEvent) => listeners.forEach((listener) => listener(event));
  return { service, publish, listeners, unsubscribed, withAccess, replaySince };
}

const params = (overrides: Partial<{ lastEventId: string; userId: string; tokenExpiresAt: Date }> = {}) => ({
  userId: 'user-1',
  organizationId: 'org-1',
  tokenExpiresAt: new Date(Date.now() + 3_600_000),
  ...overrides,
});

describe('ConsoleEventStreamService', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date('2026-11-25T10:00:00Z') }));
  afterEach(() => vi.useRealTimers());

  it('refuses someone who is not an active Owner or Business Developer, before sending anything', async () => {
    await expect(setup({ allowed: false }).service.open(params())).rejects.toMatchObject({ status: 403 });
  });

  it('streams new events after the retry hint, without the replay when not resuming', async () => {
    const { service, publish, replaySince } = setup();
    const out = sink();
    await (await service.open(params())).attach(out.sink);
    publish(streamed(7));
    expect(out.frames()).toEqual(['retry', 'voucher.paused#7']);
    expect(replaySince).not.toHaveBeenCalled();
  });

  it('a resuming client gets what it missed, then new events, each once', async () => {
    const setupWithReplay = setup({ replay: [row(5), row(6)] });
    const out = sink();
    const stream = await setupWithReplay.service.open(params({ lastEventId: '4' }));
    const attached = stream.attach(out.sink);
    // Arrives while the replay is read: buffered, and 6 is not sent twice.
    setupWithReplay.publish(streamed(6));
    setupWithReplay.publish(streamed(8));
    await attached;
    setupWithReplay.publish(streamed(9));
    expect(out.frames()).toEqual([
      'retry',
      'voucher.paused#5',
      'voucher.paused#6',
      'voucher.paused#8',
      'voucher.paused#9',
    ]);
    expect(setupWithReplay.replaySince).toHaveBeenCalledWith('org-1', 4, REPLAY_LIMIT + 1);
  });

  it.each([
    ['an id that is not a number', { lastEventId: 'abc' }, {}],
    ['an event that is gone or another organization’s', { lastEventId: '4' }, { anchor: false }],
    [
      'too much to replay',
      { lastEventId: '4' },
      { replay: Array.from({ length: REPLAY_LIMIT + 1 }, (_, i) => row(i + 5)) },
    ],
  ])('says stream.reset for %s, then carries on', async (_label, overrides, options) => {
    const { service, publish } = setup(options);
    const out = sink();
    await (await service.open(params(overrides))).attach(out.sink);
    publish(streamed(9));
    expect(out.frames()).toEqual(['retry', 'stream.reset', 'voucher.paused#9']);
  });

  it('heartbeats, and closes with stream.access_revoked once access is gone', async () => {
    let allowed = true;
    const { service, unsubscribed } = setup({ allowed: () => allowed });
    const out = sink();
    await (await service.open(params())).attach(out.sink);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(out.frames()).toEqual(['retry', 'ping']);
    allowed = false;
    await vi.advanceTimersByTimeAsync(20_000);

    expect(out.frames()).toEqual(['retry', 'ping', 'ping', 'stream.access_revoked']);
    expect(out.sink.ended).toBe(true);
    expect(unsubscribed).toHaveBeenCalledOnce();
  });

  it('a failed access check is not a revocation', async () => {
    const { service, withAccess } = setup();
    const out = sink();
    await (await service.open(params())).attach(out.sink);
    withAccess.mockRejectedValueOnce(new Error('db down'));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(out.sink.ended).toBe(false);
  });

  it('closes with stream.token_expired when the token it was opened with expires', async () => {
    const { service } = setup();
    const out = sink();
    await (await service.open(params({ tokenExpiresAt: new Date(Date.now() + 5_000) }))).attach(out.sink);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(out.frames().at(-1)).toBe('stream.token_expired');
    expect(out.sink.ended).toBe(true);
  });

  it(`holds at most ${MAX_STREAMS_PER_USER} streams per user, and frees one when its client leaves`, async () => {
    const { service, listeners } = setup();
    const sinks = [];
    for (let i = 0; i < MAX_STREAMS_PER_USER; i++) {
      const out = sink();
      sinks.push(out);
      await (await service.open(params())).attach(out.sink);
    }
    await expect(service.open(params())).rejects.toMatchObject({ status: 429 });
    await expect(service.open(params({ userId: 'user-2' }))).resolves.toBeDefined();

    sinks[0].clientLeaves();
    sinks[0].clientLeaves();
    expect(listeners.size).toBe(MAX_STREAMS_PER_USER - 1);
    await expect(service.open(params())).resolves.toBeDefined();
  });

  it('ends every open stream on shutdown, so the server can close', async () => {
    const { service, listeners } = setup();
    const outs = [sink(), sink()];
    for (const out of outs) await (await service.open(params())).attach(out.sink);
    service.beforeApplicationShutdown();
    expect(outs.every((out) => out.sink.ended)).toBe(true);
    expect(listeners.size).toBe(0);
  });

  it('closes, unsubscribed, when the replay fails', async () => {
    const { service, replaySince, unsubscribed } = setup();
    replaySince.mockRejectedValueOnce(new Error('db down'));
    const out = sink();
    await (await service.open(params({ lastEventId: '4' }))).attach(out.sink);
    expect(out.sink.ended).toBe(true);
    expect(unsubscribed).toHaveBeenCalledOnce();
  });
});
