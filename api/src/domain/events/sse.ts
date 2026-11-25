import type { OrganizationStreamControl, OrganizationStreamEvent } from '@octap/contracts';

/** Server-Sent Events framing (https://html.spec.whatwg.org/multipage/server-sent-events.html). */

/** How long a client waits before reconnecting, in ms, sent once when the stream opens. */
export const SSE_RETRY_MS = 3000;

export function sseRetry(): string {
  return `retry: ${SSE_RETRY_MS}\n\n`;
}

/** A comment line: ignored by the client, keeps proxies from closing an idle connection. */
export function sseHeartbeat(): string {
  return ': ping\n\n';
}

/** One organization event: its sequence as the SSE `id`, so a reconnect resumes after it. */
export function sseEvent(event: OrganizationStreamEvent): string {
  return `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** A message about the stream itself. No `id`, so it never moves the client's resume point. */
export function sseControl(type: OrganizationStreamControl): string {
  return `event: ${type}\ndata: {}\n\n`;
}
