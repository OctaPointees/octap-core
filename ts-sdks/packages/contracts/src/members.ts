import type { CreditBalanceSnapshot } from './loyalty.js';
export interface MemberDirectoryQuery {
  limit?: number;
  cursor?: string;
  q?: string;
  status?: 'ACTIVE' | 'BLOCKED';
  externalMemberId?: string;
}
export interface MemberProfile {
  id: string;
  endUserId: string;
  displayName: string | null;
  email: string | null;
  phoneNumber: string | null;
  status: string;
  externalMemberId: string | null;
  metadata: unknown;
  joinedAt: string;
}
export interface MemberProfilePatch {
  status?: 'ACTIVE' | 'BLOCKED';
  externalMemberId?: string | null;
  metadata?: Record<string, unknown>;
}
export interface MemberDirectoryPage {
  items: MemberProfile[];
  nextCursor: string | null;
}
export interface MemberDetail extends MemberProfile {
  balance: CreditBalanceSnapshot;
}
