import Redis from 'ioredis';
import { buildApp } from './app.js';
import { config } from './config.js';
import { EventHub } from './eventHub.js';

const log = Object.fromEntries(['info', 'warn', 'error'].map((level) => [level, (msg, fields = {}) => {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, service: 'gateway', msg, ...fields });
  (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);
}]));

if (config.jwtSecret.startsWith('dev-only')) log.warn('JWT_SECRET is the development default');

const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
const streamRedis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
redis.on('error', (err) => log.warn('redis error', { error: err.message }));

const hub = new EventHub(streamRedis, config.eventsStream, { log });
hub.start();

const { app } = buildApp({ config, redis, hub, log });
const server = app.listen(config.port, () => log.info('gateway listening', { port: config.port }));
server.keepAliveTimeout = 65_000;

function shutdown() {
  hub.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
