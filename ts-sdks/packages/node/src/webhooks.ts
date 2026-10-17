import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifies an OctaP webhook's `x-octap-signature` header against the exact raw request body
 * bytes (parse the body only after this returns true — a re-serialized JSON object will not
 * match if key order or whitespace differs from what was actually sent).
 */
export function verifyWebhookSignature(rawBody: string, signature: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  let actualBuf: Buffer;
  try {
    actualBuf = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  return expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);
}

/**
 * Reference pattern for an idempotent receiver: OctaP retries a delivery (and a human can
 * replay a dead-lettered one) without ever changing its `x-octap-event-id`, so a receiver only
 * needs to remember ids it has already processed.
 *
 * ```ts
 * const seen = new Set<string>(); // swap for a real store (DB/Redis) in production
 * app.post('/webhooks/octap', (req, res) => {
 *   const eventId = req.headers['x-octap-event-id'] as string;
 *   if (!verifyWebhookSignature(req.rawBody, req.headers['x-octap-signature'] as string, secret)) {
 *     return res.status(401).end();
 *   }
 *   if (seen.has(eventId)) return res.status(200).end(); // already handled; ack without re-applying
 *   seen.add(eventId);
 *   // ...apply the event exactly once...
 *   res.status(200).end();
 * });
 * ```
 */
