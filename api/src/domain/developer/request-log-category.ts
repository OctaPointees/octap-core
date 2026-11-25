import type { RequestLogCategory } from '@octap/contracts';

/**
 * The part of the API a route belongs to, for grouping a merchant's calls. Decided by the route's
 * first segment after `/v1/` (and the second, under `/v1/rewards`), so a new route in an existing
 * controller lands in the right category without touching this file.
 */
export function categoryOf(route: string): RequestLogCategory {
  const [version, first, second] = route.split('?')[0].split('/').filter(Boolean);
  if (version !== 'v1') return 'other';
  switch (first) {
    case 'credits':
      return 'credits';
    case 'rewards':
      return second === 'refund-policy' ? 'refund-policy' : 'vouchers';
    case 'webhooks':
      return 'webhooks';
    case 'organizations':
      return 'organizations';
    default:
      return 'other';
  }
}
