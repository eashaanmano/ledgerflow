import { randomBytes, randomUUID } from 'node:crypto';
import express from 'express';
import { EVENT_TYPES, config } from './config.js';
import { pool } from './db.js';
import { checkEndpointUrl } from './urlPolicy.js';

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function clientOf(req) {
  const id = req.get('x-client-id');
  if (!id) throw new HttpError(401, 'unauthenticated', 'X-Client-Id header missing');
  return id;
}

function uuidParam(req, name = 'id') {
  const v = req.params[name];
  if (!UUID_RE.test(v)) throw new HttpError(404, 'not_found', 'not found');
  return v;
}

const limitOf = (req, dflt = 50) => Math.max(1, Math.min(Number.parseInt(req.query.limit ?? dflt, 10) || dflt, 500));

const publicEndpoint = ({ secret, ...rest }) => ({ ...rest, secretHint: `${secret.slice(0, 10)}…` });

export function buildApi() {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  app.get('/health', wrap(async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ status: 'UP' });
  }));

  app.post('/endpoints', wrap(async (req, res) => {
    const clientId = clientOf(req);
    const { url, secret, events = ['*'], description } = req.body ?? {};

    const urlError = typeof url === 'string' ? await checkEndpointUrl(url, { allowPrivate: config.allowPrivateUrls }) : 'url is required';
    if (urlError) throw new HttpError(400, 'invalid_url', urlError);
    if (!Array.isArray(events) || events.length === 0 || events.some((e) => e !== '*' && !EVENT_TYPES.includes(e))) {
      throw new HttpError(400, 'invalid_events', `events must be a non-empty list of: *, ${EVENT_TYPES.join(', ')}`);
    }
    if (secret !== undefined && (typeof secret !== 'string' || secret.length < 16 || secret.length > 128)) {
      throw new HttpError(400, 'invalid_secret', 'secret must be 16-128 characters');
    }

    const finalSecret = secret ?? `whsec_${randomBytes(24).toString('base64url')}`;
    const { rows } = await pool.query(
      `INSERT INTO endpoints (id, client_id, url, secret, events, description)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, client_id AS "clientId", url, events, description, active, created_at AS "createdAt"`,
      [randomUUID(), clientId, url, finalSecret, [...new Set(events)], description ?? null],
    );
    // The secret is only ever returned on creation.
    res.status(201).json({ ...rows[0], secret: finalSecret });
  }));

  app.get('/endpoints', wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT id, url, events, description, active, secret, created_at AS "createdAt"
         FROM endpoints WHERE client_id = $1 ORDER BY created_at DESC`,
      [clientOf(req)],
    );
    res.json({ data: rows.map(publicEndpoint) });
  }));

  app.delete('/endpoints/:id', wrap(async (req, res) => {
    const { rowCount } = await pool.query(
      'UPDATE endpoints SET active = FALSE WHERE id = $1 AND client_id = $2',
      [uuidParam(req), clientOf(req)],
    );
    if (!rowCount) throw new HttpError(404, 'not_found', 'endpoint not found');
    res.status(204).end();
  }));

  app.get('/deliveries', wrap(async (req, res) => {
    const clientId = clientOf(req);
    const params = [clientId];
    let where = 'd.client_id = $1';
    if (req.query.status) {
      params.push(String(req.query.status));
      where += ` AND d.status = $${params.length}`;
    }
    if (req.query.endpointId && UUID_RE.test(String(req.query.endpointId))) {
      params.push(String(req.query.endpointId));
      where += ` AND d.endpoint_id = $${params.length}`;
    }
    params.push(limitOf(req));
    const { rows } = await pool.query(
      `SELECT d.id, d.event_id AS "eventId", d.event_type AS "eventType", d.endpoint_id AS "endpointId", e.url,
              d.status, d.attempts, d.last_status_code AS "lastStatusCode", d.last_error AS "lastError",
              d.next_attempt_at AS "nextAttemptAt", d.created_at AS "createdAt", d.delivered_at AS "deliveredAt",
              d.request_id AS "requestId"
         FROM deliveries d JOIN endpoints e ON e.id = d.endpoint_id
        WHERE ${where}
        ORDER BY d.created_at DESC
        LIMIT $${params.length}`,
      params,
    );
    res.json({ data: rows });
  }));

  app.get('/deliveries/stats', wrap(async (req, res) => {
    const { rows } = await pool.query(
      'SELECT status, count(*)::int AS count FROM deliveries WHERE client_id = $1 GROUP BY status',
      [clientOf(req)],
    );
    const stats = { pending: 0, delivering: 0, succeeded: 0, dead: 0 };
    for (const r of rows) stats[r.status] = r.count;
    res.json(stats);
  }));

  app.get('/deliveries/:id', wrap(async (req, res) => {
    const id = uuidParam(req);
    const { rows } = await pool.query(
      `SELECT d.id, d.event_id AS "eventId", d.event_type AS "eventType", d.endpoint_id AS "endpointId", e.url,
              d.status, d.attempts, d.payload, d.last_status_code AS "lastStatusCode", d.last_error AS "lastError",
              d.next_attempt_at AS "nextAttemptAt", d.created_at AS "createdAt", d.delivered_at AS "deliveredAt",
              d.request_id AS "requestId"
         FROM deliveries d JOIN endpoints e ON e.id = d.endpoint_id
        WHERE d.id = $1 AND d.client_id = $2`,
      [id, clientOf(req)],
    );
    if (!rows.length) throw new HttpError(404, 'not_found', 'delivery not found');
    const { rows: attempts } = await pool.query(
      `SELECT attempt, status_code AS "statusCode", error, duration_ms AS "durationMs",
              response_snippet AS "responseSnippet", created_at AS "createdAt"
         FROM delivery_attempts WHERE delivery_id = $1 ORDER BY attempt, id`,
      [id],
    );
    res.json({ ...rows[0], attemptLog: attempts });
  }));

  // Manual replay: put a dead (or already delivered) event back on the queue with a fresh retry budget.
  // The attempt log is kept, so the history of the original failure is not lost.
  app.post('/deliveries/:id/replay', wrap(async (req, res) => {
    const { rows } = await pool.query(
      `UPDATE deliveries SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL, updated_at = now()
        WHERE id = $1 AND client_id = $2 AND status IN ('dead', 'succeeded')
        RETURNING id, status`,
      [uuidParam(req), clientOf(req)],
    );
    if (!rows.length) throw new HttpError(409, 'not_replayable', 'delivery not found or still in flight');
    res.status(202).json(rows[0]);
  }));

  app.get('/dead-letters', wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT d.id, d.event_id AS "eventId", d.event_type AS "eventType", e.url, d.attempts,
              d.last_status_code AS "lastStatusCode", d.last_error AS "lastError", d.updated_at AS "deadSince"
         FROM deliveries d JOIN endpoints e ON e.id = d.endpoint_id
        WHERE d.client_id = $1 AND d.status = 'dead'
        ORDER BY d.updated_at DESC LIMIT $2`,
      [clientOf(req), limitOf(req, 100)],
    );
    res.json({ data: rows });
  }));

  app.post('/dead-letters/replay', wrap(async (req, res) => {
    const clientId = clientOf(req);
    const endpointId = req.body?.endpointId;
    if (endpointId !== undefined && !UUID_RE.test(String(endpointId))) throw new HttpError(400, 'invalid_endpoint', 'endpointId must be a UUID');
    const { rowCount } = await pool.query(
      `UPDATE deliveries SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL, updated_at = now()
        WHERE client_id = $1 AND status = 'dead' AND ($2::uuid IS NULL OR endpoint_id = $2::uuid)`,
      [clientId, endpointId ?? null],
    );
    res.status(202).json({ replayed: rowCount });
  }));

  app.use((_req, _res, next) => next(new HttpError(404, 'not_found', 'no such route')));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'malformed_request', message: 'invalid JSON' } });
    process.stderr.write(`${JSON.stringify({ level: 'error', service: 'webhook-service', msg: 'unhandled', error: err.stack })}\n`);
    return res.status(500).json({ error: { code: 'internal_error', message: 'unexpected error' } });
  });

  return app;
}
