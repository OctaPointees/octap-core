import type { ReactNode } from 'react';
/** Reserved admin layout boundary; authorization is not implemented. */
export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
