import { Agent, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { listen } from '../src/http.js';

type Server = Awaited<ReturnType<typeof listen>>;
let server: Server | undefined;

afterEach(async () => {
  await new Promise((resolve) => server?.close(resolve));
  server = undefined;
});

const port = () => (server!.address() as AddressInfo).port;

function get(agent: Agent, path = '/'): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: port(), path, agent }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('listen (the node:http bridge for serve-http)', () => {
  it('keeps no listener per request on a kept-alive connection, as a proxy or tunnel sends them', async () => {
    const sockets = new Set<import('node:net').Socket>();
    server = await listen(async () => new Response('ok'), 0, '127.0.0.1');
    server.on('connection', (socket) => sockets.add(socket));
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    for (let i = 0; i < 30; i++) expect(await get(agent)).toBe('ok');
    expect(sockets.size).toBe(1);
    // Node's own listeners only; before, each request added one, warning after 10.
    expect([...sockets][0].listenerCount('close')).toBeLessThan(5);
    agent.destroy();
  });

  it('aborts the request when the client goes away before the response ends, and only then', async () => {
    const signals: AbortSignal[] = [];
    let gotRequest!: () => void;
    const requested = new Promise<void>((resolve) => (gotRequest = resolve));
    server = await listen(
      async (request) => {
        signals.push(request.signal);
        if (new URL(request.url).pathname === '/done') return new Response('done');
        gotRequest();
        // A stream that never ends, like an MCP SSE response.
        return new Response(new ReadableStream({ start() {} }));
      },
      0,
      '127.0.0.1',
    );
    const agent = new Agent({ keepAlive: true });
    expect(await get(agent, '/done')).toBe('done');

    const req = httpRequest({ host: '127.0.0.1', port: port(), path: '/stream', agent });
    req.on('error', () => undefined);
    req.end();
    await requested;
    req.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(signals[0].aborted).toBe(false);
    expect(signals[1].aborted).toBe(true);
    agent.destroy();
  });
});
