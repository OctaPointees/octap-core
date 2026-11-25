import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantStreamEvent } from '@octap/contracts';
import { ConsoleAssistantController, HEARTBEAT_MS } from '#api/rest/console-assistant.controller.js';
import type { ConsoleRequest } from '#api/rest/console-access.guard.js';
import type { AssistantService, AssistantTurnRequest } from '#domain/assistant/assistant.service.js';

const ORG = '11111111-1111-4111-8111-111111111111';

/** An Express-like response that records what was written and can be closed by the "client". */
function response() {
  const listeners: Array<() => void> = [];
  const res = {
    chunks: [] as string[],
    writableEnded: false,
    status: vi.fn(),
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn((chunk: string) => {
      res.chunks.push(chunk);
      return true;
    }),
    end: vi.fn(() => {
      res.writableEnded = true;
    }),
    on: vi.fn((_event: 'close', listener: () => void) => {
      listeners.push(listener);
    }),
    disconnect: () => listeners.forEach((listener) => listener()),
  };
  return res;
}

const request = { consoleIdentity: { user: { id: 'user-1' } } } as unknown as ConsoleRequest;

describe('ConsoleAssistantController (OCT-308)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts a turn whose client left while it was being prepared', async () => {
    const res = response();
    let signal: AbortSignal | undefined;
    const assistant = {
      prepare: vi.fn(async () => {
        res.disconnect();
        return {} as AssistantTurnRequest;
      }),
      async *stream(_turn: AssistantTurnRequest, received: AbortSignal): AsyncGenerator<AssistantStreamEvent> {
        signal = received;
        if (!received.aborted) yield { type: 'done', reason: 'complete' };
      },
    };
    const controller = new ConsoleAssistantController(assistant as unknown as AssistantService);
    await controller.message(request, ORG, { message: 'Hi' }, res);
    expect(signal?.aborted).toBe(true);
  });

  it('sends an SSE comment while the answer is quiet, and stops once it ends', async () => {
    vi.useFakeTimers();
    const res = response();
    let finish: () => void = () => undefined;
    const assistant = {
      prepare: vi.fn(async () => ({}) as AssistantTurnRequest),
      async *stream(): AsyncGenerator<AssistantStreamEvent> {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        yield { type: 'done', reason: 'complete' };
      },
    };
    const controller = new ConsoleAssistantController(assistant as unknown as AssistantService);
    const pending = controller.message(request, ORG, { message: 'Hi' }, res);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(res.chunks).toEqual([':\n\n', ':\n\n']);

    finish();
    await pending;
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(res.chunks).toEqual([':\n\n', ':\n\n', 'event: done\ndata: {"type":"done","reason":"complete"}\n\n']);
    expect(res.end).toHaveBeenCalledOnce();
  });
});
