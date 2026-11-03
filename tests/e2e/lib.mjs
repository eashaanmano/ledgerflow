import { randomUUID } from 'node:crypto';

export const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
export const API_KEY = process.env.API_KEY ?? 'sk_test_load';

export async function call(method, path, { body, key, headers = {} } = {}) {
  const started = performance.now();
  const res = await fetch(`${BASE_URL}/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${API_KEY}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json, headers: res.headers, ms: performance.now() - started };
}

export async function must(method, path, opts, expected = [200, 201, 202, 204]) {
  const res = await call(method, path, opts);
  if (!expected.includes(res.status)) {
    throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(res.json)}`);
  }
  return res.json;
}

export async function createFundedAccounts(n, amount, currency = 'USD') {
  const ids = [];
  for (let i = 0; i < n; i += 1) {
    const acct = await must('POST', '/accounts', { body: { name: `e2e-${Date.now()}-${i}`, currency } });
    await must('POST', '/deposits', { body: { accountId: acct.id, amount }, key: randomUUID() });
    ids.push(acct.id);
  }
  return ids;
}

/** Runs `tasks` (functions returning promises) with at most `limit` in flight. */
export async function pool(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next;
      next += 1;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

export function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function assert(cond, message) {
  if (!cond) {
    console.error(`\n  FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`  ok: ${message}`);
  }
  return cond;
}
