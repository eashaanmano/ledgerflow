import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import Redis from 'ioredis';

// Needs a real Redis (REDIS_URL, default localhost). Skipped automatically if none is reachable.
const lua = readFileSync(new URL('../src/tokenBucket.lua', import.meta.url), 'utf8');
let redis;
let available = false;

before(async () => {
  redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
  try {
    await redis.connect();
    available = true;
    redis.defineCommand('tokenBucket', { numberOfKeys: 1, lua });
  } catch {
    available = false;
  }
});

after(() => redis?.disconnect());

const key = () => `test:bucket:${Math.random()}`;

test('burst is allowed, then requests are refused', async (t) => {
  if (!available) return t.skip('redis not reachable');
  const k = key();
  const results = [];
  for (let i = 0; i < 7; i += 1) results.push((await redis.tokenBucket(k, 5, 1, 1))[0]);
  assert.deepEqual(results, [1, 1, 1, 1, 1, 0, 0]);
  const [, remaining, retryAfterMs] = await redis.tokenBucket(k, 5, 1, 1);
  assert.equal(remaining, 0);
  assert.ok(retryAfterMs > 0 && retryAfterMs <= 1000);
});

test('tokens refill over time', async (t) => {
  if (!available) return t.skip('redis not reachable');
  const k = key();
  for (let i = 0; i < 3; i += 1) await redis.tokenBucket(k, 3, 20, 1);
  assert.equal((await redis.tokenBucket(k, 3, 20, 1))[0], 0);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal((await redis.tokenBucket(k, 3, 20, 1))[0], 1);
});

test('concurrent callers never overspend the bucket', async (t) => {
  if (!available) return t.skip('redis not reachable');
  const k = key();
  const results = await Promise.all(Array.from({ length: 200 }, () => redis.tokenBucket(k, 50, 0.001, 1)));
  assert.equal(results.filter(([allowed]) => allowed === 1).length, 50);
});
