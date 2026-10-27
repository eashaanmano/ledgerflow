import { backoffMs } from './backoff.js';
import { config } from './config.js';
import { pool, withTransaction } from './db.js';
import { log } from './logger.js';
import { deliverOnce } from './delivery.js';

/*
 * Claims due deliveries with a lease. If this process dies mid-delivery, the lease expires and
 * another tick (here or on another replica) picks the row up again. That can mean a second POST
 * for the same event, which is why delivery is at-least-once and receivers dedupe on event id.
 */
async function claimDue(limit) {
  const { rows } = await pool.query(
    `UPDATE deliveries d
        SET status = 'delivering', lease_expires_at = now() + make_interval(secs => $2::double precision / 1000), updated_at = now()
       FROM endpoints e
      WHERE e.id = d.endpoint_id
        AND d.id IN (
          SELECT id FROM deliveries
           WHERE (status = 'pending' AND next_attempt_at <= now())
              OR (status = 'delivering' AND lease_expires_at < now())
           ORDER BY next_attempt_at
           LIMIT $1
           FOR UPDATE SKIP LOCKED)
     RETURNING d.id, d.event_id, d.event_type, d.payload, d.request_id, d.attempts, e.url, e.secret, e.active`,
    [limit, config.leaseMs],
  );
  return rows;
}

async function record(d, result) {
  const attempt = d.attempts + 1;
  await withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO delivery_attempts (delivery_id, attempt, status_code, error, duration_ms, response_snippet)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [d.id, attempt, result.statusCode, result.error, result.durationMs, result.snippet],
    );

    const lastError = result.ok ? null : (result.error ?? `HTTP ${result.statusCode}`);
    if (result.ok) {
      await tx.query(
        `UPDATE deliveries SET status = 'succeeded', attempts = $2, last_status_code = $3, last_error = NULL,
                delivered_at = now(), lease_expires_at = NULL, updated_at = now()
          WHERE id = $1 AND status = 'delivering'`,
        [d.id, attempt, result.statusCode],
      );
    } else if (attempt >= config.maxAttempts) {
      await tx.query(
        `UPDATE deliveries SET status = 'dead', attempts = $2, last_status_code = $3, last_error = $4,
                lease_expires_at = NULL, updated_at = now()
          WHERE id = $1 AND status = 'delivering'`,
        [d.id, attempt, result.statusCode, lastError],
      );
      log.warn('delivery dead-lettered', { deliveryId: d.id, eventId: d.event_id, attempts: attempt, error: lastError, requestId: d.request_id });
    } else {
      const delay = backoffMs(attempt, { baseMs: config.backoffBaseMs, capMs: config.backoffCapMs });
      await tx.query(
        `UPDATE deliveries SET status = 'pending', attempts = $2, last_status_code = $3, last_error = $4,
                next_attempt_at = now() + make_interval(secs => $5::double precision / 1000),
                lease_expires_at = NULL, updated_at = now()
          WHERE id = $1 AND status = 'delivering'`,
        [d.id, attempt, result.statusCode, lastError, delay],
      );
    }
  });
}

async function processDelivery(d) {
  if (!d.active) {
    await pool.query(
      `UPDATE deliveries SET status = 'dead', last_error = 'endpoint disabled', lease_expires_at = NULL, updated_at = now() WHERE id = $1`,
      [d.id],
    );
    return;
  }
  const result = await deliverOnce(d);
  await record(d, result);
}

export function startDispatcher({ signal }) {
  let running = false;
  const timer = setInterval(async () => {
    if (running || signal.aborted) return;
    running = true;
    try {
      let batch;
      do {
        batch = await claimDue(config.dispatchBatch);
        await Promise.all(batch.map((d) => processDelivery(d).catch((err) => log.error('delivery processing failed', { deliveryId: d.id, error: err.message }))));
      } while (batch.length === config.dispatchBatch && !signal.aborted);
    } catch (err) {
      log.error('dispatcher tick failed', { error: err.message });
    } finally {
      running = false;
    }
  }, config.dispatchIntervalMs);
  signal.addEventListener('abort', () => clearInterval(timer));
}
