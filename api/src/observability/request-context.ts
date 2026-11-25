import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Who is acting (OCT-333): the console user, the API key, or OctaP itself. A worker, the indexer
 * or a script has no request, so it acts as `SYSTEM`.
 */
export type AuditActor =
  { type: 'USER'; id: string } | { type: 'CREDENTIAL'; id: string } | { type: 'SYSTEM'; id: null };

export const SYSTEM_ACTOR: AuditActor = { type: 'SYSTEM', id: null };

interface RequestContext {
  requestId: string;
  actor?: AuditActor;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Runs the rest of an HTTP request inside its own context. `CorrelationIdMiddleware` calls it
 * first, before any guard; the guards then say who is acting (`setRequestActor`). Everything the
 * request does afterwards, across every `await`, sees the same context, so a write records its
 * actor without each service passing one down.
 */
export function runInRequestContext<T>(requestId: string, work: () => T): T {
  return storage.run({ requestId }, work);
}

/** Called by `ApiKeyGuard` and `ConsoleAccessGuard` once they have authenticated the caller. */
export function setRequestActor(actor: AuditActor): void {
  const context = storage.getStore();
  if (context) context.actor = actor;
}

/** The authenticated caller of the current request, or `SYSTEM` outside one or before a guard. */
export function currentActor(): AuditActor {
  return storage.getStore()?.actor ?? SYSTEM_ACTOR;
}

/** Whether the current request has an authenticated caller: a public route or a worker has none. */
export function hasRequestActor(): boolean {
  return storage.getStore()?.actor !== undefined;
}

/** The current request's correlation id (OCT-60), or undefined outside a request. */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
