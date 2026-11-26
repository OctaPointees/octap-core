import { describe, expect, it } from 'vitest';
import {
  currentActor,
  currentRequestId,
  hasRequestActor,
  runInRequestContext,
  setRequestActor,
  SYSTEM_ACTOR,
} from '#observability/request-context.js';
import { auditTargetOfEvent } from '#infra/db/repositories/audit.repository.js';

describe('request context (OCT-333)', () => {
  it('outside a request, the actor is SYSTEM and there is no request id', () => {
    expect(currentActor()).toEqual(SYSTEM_ACTOR);
    expect(hasRequestActor()).toBe(false);
    expect(currentRequestId()).toBeUndefined();
  });

  it('carries the request id, and the actor a guard sets, across awaits', async () => {
    await runInRequestContext('req-1', async () => {
      expect(hasRequestActor()).toBe(false);
      setRequestActor({ type: 'CREDENTIAL', id: 'key-1' });
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(currentActor()).toEqual({ type: 'CREDENTIAL', id: 'key-1' });
      expect(currentRequestId()).toBe('req-1');
    });
    expect(currentActor()).toEqual(SYSTEM_ACTOR);
  });

  it('keeps concurrent requests apart', async () => {
    const seen: string[] = [];
    await Promise.all(
      ['a', 'b'].map((id) =>
        runInRequestContext(`req-${id}`, async () => {
          setRequestActor({ type: 'USER', id });
          await new Promise((resolve) => setTimeout(resolve, id === 'a' ? 5 : 1));
          seen.push(`${currentRequestId()}:${currentActor().id}`);
        }),
      ),
    );
    expect(seen.sort()).toEqual(['req-a:a', 'req-b:b']);
  });

  it('setting an actor outside a request is a no-op', () => {
    setRequestActor({ type: 'USER', id: 'u' });
    expect(currentActor()).toEqual(SYSTEM_ACTOR);
  });
});

describe('auditTargetOfEvent', () => {
  it.each([
    ['credits.earned', { transactionId: 't1' }, { type: 'loyalty_transaction', id: 't1' }],
    [
      'credits.reversed',
      { reversalTransactionId: 'r1', transactionId: 'x' },
      { type: 'loyalty_transaction', id: 'r1' },
    ],
    ['voucher.granted', { voucherOwnershipId: 'o1', voucherId: 'v1' }, { type: 'voucher_ownership', id: 'o1' }],
    ['voucher.activated', { voucherId: 'v1' }, { type: 'voucher', id: 'v1' }],
    ['budget.low', { threshold: 80 }, { type: 'organization', id: null }],
  ])('%s is about %j', (type, payload, target) => {
    expect(auditTargetOfEvent(type, payload)).toEqual(target);
  });
});
