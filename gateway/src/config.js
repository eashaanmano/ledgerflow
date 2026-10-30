const int = (name, fallback) => {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : Number(v);
};

/*
 * API_KEYS format: "<key>:<clientId>:<requestsPerSecond>:<burst>" separated by commas.
 * Real deployments would keep hashed keys in a database; env config keeps the demo self-contained.
 */
function parseApiKeys(raw) {
  return String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [key, clientId, rate, burst] = entry.split(':');
      if (!key || !clientId) throw new Error(`Invalid API_KEYS entry: ${entry}`);
      return { key, clientId, rate: Number(rate) || 20, burst: Number(burst) || 40 };
    });
}

export const config = {
  port: int('PORT', 3000),
  ledgerUrl: process.env.LEDGER_URL ?? 'http://localhost:8080',
  webhooksUrl: process.env.WEBHOOKS_URL ?? 'http://localhost:3001',
  mockReceiverUrl: process.env.MOCK_RECEIVER_URL ?? 'http://localhost:4000',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  eventsStream: process.env.EVENTS_STREAM ?? 'ledger.events',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-only-change-me-dev-only-change-me',
  jwtTtlSec: int('JWT_TTL_SEC', 900),
  apiKeys: parseApiKeys(process.env.API_KEYS ?? 'sk_test_demo:demo-client:20:40,sk_test_load:load-client:5000:5000'),
  upstreamTimeoutMs: int('UPSTREAM_TIMEOUT_MS', 5000),
  breaker: {
    windowMs: int('BREAKER_WINDOW_MS', 10_000),
    minRequests: int('BREAKER_MIN_REQUESTS', 10),
    failureRate: int('BREAKER_FAILURE_RATE', 0.5),
    cooldownMs: int('BREAKER_COOLDOWN_MS', 5000),
  },
};
