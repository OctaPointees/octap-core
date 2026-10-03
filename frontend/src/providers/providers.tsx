import type { ReactNode } from 'react';
/** Composition slot for session, tenant and query providers. No contexts are implemented. */
export function Providers({ children }: { children: ReactNode }) {
  return children;
}
