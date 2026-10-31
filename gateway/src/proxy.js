const FORWARD_REQUEST_HEADERS = ['content-type', 'accept', 'idempotency-key'];
const FORWARD_RESPONSE_HEADERS = ['content-type', 'idempotent-replayed', 'location'];

/**
 * Forwards a request upstream through a circuit breaker. 5xx, timeouts and connection errors
 * count as failures; 4xx are the caller's problem and count as successes for the breaker.
 * POSTs are never retried here: only the client knows whether a retry is safe (it holds the key).
 */
export function createProxy({ timeoutMs, log }) {
  return async function forward(req, res, { baseUrl, path, breaker }) {
    if (breaker && !breaker.allowRequest()) {
      res.set('Retry-After', String(Math.max(1, Math.ceil(breaker.retryAfterMs() / 1000))));
      return res.status(503).json({ error: { code: 'upstream_unavailable', message: `${breaker.name} circuit is open` } });
    }

    const headers = { 'x-request-id': req.id, 'x-client-id': req.client.clientId };
    for (const h of FORWARD_REQUEST_HEADERS) {
      const v = req.get(h);
      if (v) headers[h] = v;
    }
    const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    const hasBody = !['GET', 'HEAD', 'DELETE'].includes(req.method) && Buffer.isBuffer(req.body) && req.body.length > 0;

    let failed = true;
    try {
      const upstream = await fetch(`${baseUrl}${path}${query}`, {
        method: req.method,
        headers,
        body: hasBody ? req.body : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = Buffer.from(await upstream.arrayBuffer());
      failed = upstream.status >= 500;
      res.status(upstream.status);
      for (const h of FORWARD_RESPONSE_HEADERS) {
        const v = upstream.headers.get(h);
        if (v) res.set(h, v);
      }
      return res.send(body);
    } catch (err) {
      const timeout = err.name === 'TimeoutError';
      log.warn('upstream call failed', { upstream: breaker?.name ?? baseUrl, error: timeout ? 'timeout' : err.message, requestId: req.id });
      return res.status(timeout ? 504 : 502).json({
        error: { code: timeout ? 'upstream_timeout' : 'upstream_error', message: `${breaker?.name ?? 'upstream'} did not respond` },
      });
    } finally {
      if (breaker) (failed ? breaker.onFailure() : breaker.onSuccess());
    }
  };
}
