import { createHmac, timingSafeEqual } from 'node:crypto';

/*
 * What a LedgerFlow customer would write on their side. Deliberately a standalone copy rather than
 * an import from the webhook service: receivers verify with the documented scheme, not our code.
 */
export function verify(secret, rawBody, header, toleranceSec = 300) {
  const parts = Object.fromEntries(String(header ?? '').split(',').map((p) => p.split('=').map((s) => s.trim())));
  const t = Number.parseInt(parts.t, 10);
  if (!Number.isFinite(t) || !parts.v1) return 'malformed signature header';
  if (Math.abs(Date.now() / 1000 - t) > toleranceSec) return 'timestamp outside tolerance';
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  const given = Buffer.from(parts.v1, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected) ? null : 'signature mismatch';
}
