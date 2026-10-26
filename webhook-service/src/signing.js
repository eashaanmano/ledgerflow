import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'LedgerFlow-Signature';
export const DEFAULT_TOLERANCE_SEC = 300;

/*
 * Stripe-style scheme. The timestamp is part of the signed message, so an attacker who captures
 * a request cannot re-send it later with a fresh timestamp: changing t breaks v1.
 *   header:  t=<unix seconds>,v1=<hex(HMAC_SHA256(secret, "<t>.<raw body>"))>
 */
export function computeSignature(secret, timestamp, body) {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function signatureHeader(secret, body, timestamp = Math.floor(Date.now() / 1000)) {
  return `t=${timestamp},v1=${computeSignature(secret, timestamp, body)}`;
}

export function parseSignatureHeader(header) {
  const out = { t: null, v1: [] };
  for (const part of String(header ?? '').split(',')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === 't') out.t = Number.parseInt(value, 10);
    if (key === 'v1') out.v1.push(value);
  }
  return out;
}

/** Receiver-side check. `body` must be the raw request bytes, not re-serialized JSON. */
export function verifySignature(secret, body, header, { toleranceSec = DEFAULT_TOLERANCE_SEC, now = Date.now() } = {}) {
  const { t, v1 } = parseSignatureHeader(header);
  if (!Number.isFinite(t) || v1.length === 0) return { ok: false, reason: 'malformed_header' };
  if (Math.abs(Math.floor(now / 1000) - t) > toleranceSec) return { ok: false, reason: 'timestamp_out_of_tolerance' };

  const expected = Buffer.from(computeSignature(secret, t, body), 'hex');
  const match = v1.some((candidate) => {
    const given = Buffer.from(candidate, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  return match ? { ok: true } : { ok: false, reason: 'signature_mismatch' };
}
