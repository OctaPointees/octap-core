import type { Redis } from 'ioredis';

/**
 * In-memory stand-in for the slice of ioredis this codebase calls: `get`/`set` (with `NX`),
 * `del`, `incr`, `expire`. TTLs are recorded, not enforced.
 */
export function fakeRedis() {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();
  const client = {
    store,
    ttls,
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async set(key: string, value: string, ...args: unknown[]) {
      if (args.includes('NX') && store.has(key)) {
        return null;
      }
      store.set(key, String(value));
      const exIndex = args.indexOf('EX');
      if (exIndex !== -1) {
        ttls.set(key, Number(args[exIndex + 1]));
      }
      return 'OK';
    },
    async del(key: string) {
      return store.delete(key) ? 1 : 0;
    },
    async incr(key: string) {
      const next = Number(store.get(key) ?? 0) + 1;
      store.set(key, String(next));
      return next;
    },
    async expire(key: string, seconds: number) {
      ttls.set(key, seconds);
      return 1;
    },
  };
  return client as typeof client & Redis;
}
