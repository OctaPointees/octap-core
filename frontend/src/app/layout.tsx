import type { ReactNode } from 'react';
import { Providers } from '../providers/providers';
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="vi"><body><Providers>{children}</Providers></body></html>;
}
