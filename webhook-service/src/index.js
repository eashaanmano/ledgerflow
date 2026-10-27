import Redis from 'ioredis';
import { buildApi } from './api.js';
import { config } from './config.js';
import { migrate, pool } from './db.js';
import { startDispatcher } from './dispatcher.js';
import { startIngest } from './ingest.js';
import { log } from './logger.js';

await migrate();

// Dedicated connection: XREADGROUP BLOCK holds it while waiting.
const streamRedis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
const controller = new AbortController();

startIngest(streamRedis, { signal: controller.signal }).catch((err) => {
  log.error('ingest stopped', { error: err.message });
  process.exit(1);
});
startDispatcher({ signal: controller.signal });

const server = buildApi().listen(config.port, () => {
  log.info('webhook service listening', { port: config.port, consumer: config.consumerName, maxAttempts: config.maxAttempts });
});

async function shutdown(sig) {
  log.info('shutting down', { signal: sig });
  controller.abort();
  server.close();
  streamRedis.disconnect();
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
