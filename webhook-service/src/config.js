import os from 'node:os';

const int = (name, fallback) => {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : Number.parseInt(v, 10);
};

export const config = {
  port: int('PORT', 3001),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://ledgerflow:ledgerflow@localhost:5432/webhooks',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  stream: process.env.EVENTS_STREAM ?? 'ledger.events',
  consumerGroup: process.env.CONSUMER_GROUP ?? 'webhook-service',
  consumerName: process.env.CONSUMER_NAME ?? os.hostname(),
  maxAttempts: int('MAX_ATTEMPTS', 8),
  backoffBaseMs: int('BACKOFF_BASE_MS', 1000),
  backoffCapMs: int('BACKOFF_CAP_MS', 60_000),
  deliveryTimeoutMs: int('DELIVERY_TIMEOUT_MS', 5000),
  dispatchIntervalMs: int('DISPATCH_INTERVAL_MS', 250),
  dispatchBatch: int('DISPATCH_BATCH', 50),
  leaseMs: int('DELIVERY_LEASE_MS', 30_000),
  // Only for local demos where receivers live on the docker network. Never enable in production.
  allowPrivateUrls: process.env.ALLOW_PRIVATE_URLS === 'true',
};

export const EVENT_TYPES = ['transfer.completed', 'account.created'];
