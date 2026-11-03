import type { SignerState } from './zklogin-signer.js';

export interface OctapUser {
  endUserId: string;
  /** The customer's `organizationEndUserId` in this organization. */
  memberId: string;
  suiAddress: string;
}

export interface StoredSession {
  user: OctapUser;
  idToken: string;
  signer: SignerState;
}

export type Persistence = 'session' | 'memory';

export interface SessionStore {
  load(): StoredSession | null;
  save(session: StoredSession): void;
  clear(): void;
}

function memoryStore(): SessionStore {
  let held: StoredSession | null = null;
  return {
    load: () => held,
    save: (session) => {
      held = session;
    },
    clear: () => {
      held = null;
    },
  };
}

function isStoredSession(value: unknown): value is StoredSession {
  const session = value as Partial<StoredSession> | null;
  return (
    typeof session?.user?.endUserId === 'string' &&
    typeof session.user.memberId === 'string' &&
    typeof session.user.suiAddress === 'string' &&
    typeof session.idToken === 'string' &&
    typeof session.signer?.secretKey === 'string' &&
    typeof session.signer.maxEpoch === 'number' &&
    typeof session.signer.expiresAt === 'number' &&
    typeof session.signer.proof === 'object' &&
    session.signer.proof !== null
  );
}

/**
 * Browser storage can be missing or throw (private windows, blocked site data). Losing it must only
 * cost a sign-in after reload, so every access falls back to the copy held in memory.
 */
function browserStore(storage: Storage, key: string): SessionStore {
  const memory = memoryStore();
  return {
    load() {
      try {
        const raw = storage.getItem(key);
        const parsed: unknown = raw ? JSON.parse(raw) : null;
        if (isStoredSession(parsed)) return parsed;
        if (raw) storage.removeItem(key);
      } catch {
        // Unreadable storage is the same as no stored session.
      }
      return memory.load();
    },
    save(session) {
      memory.save(session);
      try {
        storage.setItem(key, JSON.stringify(session));
      } catch {
        // Kept in memory only: the session lasts until reload.
      }
    },
    clear() {
      memory.clear();
      try {
        storage.removeItem(key);
      } catch {
        // Nothing could have been written either.
      }
    },
  };
}

export function createSessionStore(persistence: Persistence, organizationId: string): SessionStore {
  if (persistence === 'memory') return memoryStore();
  let storage: Storage | undefined;
  try {
    storage = globalThis.sessionStorage;
  } catch {
    storage = undefined;
  }
  return storage ? browserStore(storage, `octap.auth.${organizationId}`) : memoryStore();
}
