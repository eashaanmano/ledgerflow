import { randomUUID } from 'node:crypto';
import express from 'express';
import { createAuth } from './auth.js';
import { CircuitBreaker } from './circuitBreaker.js';
import { createProxy } from './proxy.js';
import { createRateLimiter } from './rateLimiter.js';

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function buildApp({ config, redis, hub, log }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  const auth = createAuth(config);
  const rateLimit = createRateLimiter(redis, { log });
  const forward = createProxy({ timeoutMs: config.upstreamTimeoutMs, log });
  const onStateChange = (e) => log.warn('circuit breaker state change', e);
  const breakers = {
    ledger: new CircuitBreaker('ledger', { ...config.breaker, onStateChange }),
    webhooks: new CircuitBreaker('webhooks', { ...config.breaker, onStateChange }),
  };

  // Request id: reuse the caller's if it is sane, otherwise mint one. It is forwarded to every
  // service, logged everywhere, and stored on emitted events and webhook deliveries.
  app.use((req, res, next) => {
    const incoming = req.get('x-request-id');
    req.id = incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    res.set('X-Request-Id', req.id);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      if (req.path === '/health') return;
      log.info('request', {
        requestId: req.id, method: req.method, path: req.path, status: res.statusCode,
        clientId: req.client?.clientId, durationMs: Number(process.hrtime.bigint() - started) / 1e6,
      });
    });
    next();
  });

  app.get('/health', (_req, res) => {
    const states = Object.values(breakers).map((b) => b.snapshot());
    res.json({ status: 'UP', breakers: states });
  });

  app.post('/v1/auth/token', auth.middleware(), rateLimit, (req, res) => {
    res.json({ accessToken: auth.issueToken(req.client.clientId), tokenType: 'Bearer', expiresIn: config.jwtTtlSec });
  });

  app.get('/v1/events/stream', auth.middleware({ allowQueryToken: true }), rateLimit, async (req, res) => {
    res.set({
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    const sub = { clientId: req.client.clientId, res };
    try {
      // Browsers send Last-Event-ID on automatic reconnects; the query param covers manual reconnects
      // (for example after refreshing an expired token, which needs a new EventSource).
      await hub.backfill(sub, req.get('last-event-id') ?? req.query.last_event_id);
    } catch (err) {
      log.warn('sse backfill failed', { error: err.message, requestId: req.id });
    }
    const unsubscribe = hub.subscribe(sub);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  const api = express.Router();
  api.use((req, res, next) => {
    // fetch() normalises "..", so /v1/accounts/../admin would otherwise escape the route table.
    if (/\.\.|%2e/i.test(req.path)) return res.status(400).json({ error: { code: 'bad_path', message: 'invalid path' } });
    return next();
  });

  const toLedger = (req, res) => forward(req, res, { baseUrl: config.ledgerUrl, path: req.path, breaker: breakers.ledger });
  api.all(/^\/(accounts|transfers|deposits)(\/.*)?$/, toLedger);
  api.all(/^\/admin\/(reconciliation|outbox)(\/.*)?$/, toLedger);

  api.all(/^\/webhooks\/(endpoints|deliveries|dead-letters)(\/.*)?$/, (req, res) =>
    forward(req, res, { baseUrl: config.webhooksUrl, path: req.path.replace(/^\/webhooks/, ''), breaker: breakers.webhooks }));

  // Demo-only route so the dashboard can flip the mock receiver into failure mode.
  api.all(/^\/mock-receiver(\/.*)?$/, (req, res) =>
    forward(req, res, { baseUrl: config.mockReceiverUrl, path: req.path.replace(/^\/mock-receiver/, '') || '/' }));

  app.use('/v1', auth.middleware(), rateLimit, express.raw({ type: '*/*', limit: '1mb' }), api);

  app.use((_req, res) => res.status(404).json({ error: { code: 'not_found', message: 'No such route' } }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    log.error('unhandled gateway error', { error: err.message, requestId: req.id });
    res.status(err.status ?? 500).json({ error: { code: 'gateway_error', message: err.expose ? err.message : 'Unexpected error' } });
  });

  return { app, breakers };
}
