import { config } from './config.js';
import { SIGNATURE_HEADER, signatureHeader } from './signing.js';

async function readCapped(response, maxBytes = 1024) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString('utf8').slice(0, maxBytes);
}

export async function deliverOnce(d, { fetchImpl = fetch } = {}) {
  const body = JSON.stringify(d.payload);
  const started = Date.now();
  try {
    const res = await fetchImpl(d.url, {
      method: 'POST',
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(config.deliveryTimeoutMs),
      headers: {
        'content-type': 'application/json',
        'user-agent': 'LedgerFlow-Webhooks/1.0',
        'ledgerflow-event-id': d.event_id,
        'ledgerflow-event-type': d.event_type,
        'ledgerflow-delivery-id': d.id,
        'ledgerflow-attempt': String(d.attempts + 1),
        [SIGNATURE_HEADER.toLowerCase()]: signatureHeader(d.secret, body),
        ...(d.request_id ? { 'x-request-id': d.request_id } : {}),
      },
    });
    const snippet = await readCapped(res);
    return { ok: res.status >= 200 && res.status < 300, statusCode: res.status, error: null, snippet, durationMs: Date.now() - started };
  } catch (err) {
    const error = err.name === 'TimeoutError' ? `timeout after ${config.deliveryTimeoutMs}ms` : (err.cause?.code ?? err.message);
    return { ok: false, statusCode: null, error, snippet: null, durationMs: Date.now() - started };
  }
}
