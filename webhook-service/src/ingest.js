import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { pool } from './db.js';
import { log } from './logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fieldsToObject(fields) {
  const out = {};
  for (let i = 0; fields && i < fields.length; i += 2) out[fields[i]] = fields[i + 1];
  return out;
}

/** Fan one ledger event out to every subscribed endpoint of every client it concerns. */
export async function fanOut(event) {
  const clientIds = Array.isArray(event.clientIds) ? event.clientIds : [];
  if (clientIds.length === 0) return 0;

  const { rows: endpoints } = await pool.query(
    `SELECT id, client_id FROM endpoints
     WHERE active AND client_id = ANY($1) AND ($2 = ANY(events) OR '*' = ANY(events))`,
    [clientIds, event.type],
  );
  let created = 0;
  for (const ep of endpoints) {
    const res = await pool.query(
      `INSERT INTO deliveries (id, event_id, event_type, endpoint_id, client_id, payload, request_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
       ON CONFLICT (event_id, endpoint_id) DO NOTHING`,
      [randomUUID(), event.id, event.type, ep.id, ep.client_id, event, event.requestId ?? null],
    );
    created += res.rowCount;
  }
  return created;
}

async function handleEntries(redis, entries) {
  for (const [id, fields] of entries) {
    if (!fields) {
      // Entry was trimmed from the stream while pending; nothing to deliver.
      await redis.xack(config.stream, config.consumerGroup, id);
      continue;
    }
    const msg = fieldsToObject(fields);
    let event;
    try {
      event = JSON.parse(msg.payload);
    } catch {
      log.error('dropping unparseable stream entry', { streamId: id });
      await redis.xack(config.stream, config.consumerGroup, id);
      continue;
    }
    const created = await fanOut(event);
    // Ack only after the delivery rows are durable. A crash before this line means the entry
    // stays in the pending list and is processed again; the unique constraint absorbs the repeat.
    await redis.xack(config.stream, config.consumerGroup, id);
    if (created > 0) log.info('event fanned out', { eventId: event.id, type: event.type, deliveries: created, requestId: event.requestId });
  }
}

export async function ensureGroup(redis) {
  try {
    await redis.xgroup('CREATE', config.stream, config.consumerGroup, '0', 'MKSTREAM');
  } catch (err) {
    if (!String(err.message).includes('BUSYGROUP')) throw err;
  }
}

/**
 * Consumer loop. Starts by re-reading this consumer's own pending entries (id "0") so work
 * that was read but not acked before a crash is finished first, then switches to new entries (">").
 */
export function startIngest(redis, { signal }) {
  let cursor = '0';

  const loop = async () => {
    await ensureGroup(redis);
    while (!signal.aborted) {
      try {
        // BLOCK only applies to new entries; reading our own pending list returns immediately.
        const block = cursor === '>' ? ['BLOCK', 2000] : [];
        const res = await redis.xreadgroup(
          'GROUP', config.consumerGroup, config.consumerName,
          'COUNT', 100, ...block,
          'STREAMS', config.stream, cursor,
        );
        const entries = res?.[0]?.[1] ?? [];
        if (cursor === '0' && entries.length === 0) {
          cursor = '>';
          continue;
        }
        await handleEntries(redis, entries);
      } catch (err) {
        log.error('ingest loop error, retrying', { error: err.message });
        cursor = '0';
        await sleep(1000);
      }
    }
  };

  // Entries left pending by a consumer that died for good are claimed after a minute of idleness.
  const reclaim = setInterval(async () => {
    try {
      const [, entries] = await redis.xautoclaim(
        config.stream, config.consumerGroup, config.consumerName, 60_000, '0-0', 'COUNT', 100,
      );
      if (entries?.length) {
        log.warn('reclaimed stale pending entries', { count: entries.length });
        await handleEntries(redis, entries);
      }
    } catch (err) {
      log.warn('xautoclaim failed', { error: err.message });
    }
  }, 30_000);
  signal.addEventListener('abort', () => clearInterval(reclaim));

  return loop();
}
