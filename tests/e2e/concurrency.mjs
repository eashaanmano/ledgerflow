/*
 * End-to-end concurrency proof through the gateway:
 *   - N random transfers between funded accounts, each sent TWICE at the same time with the
 *     same Idempotency-Key (simulating a client retry racing the original request)
 *   - verifies no transfer was applied twice, balances match a model built from responses,
 *     money is conserved, no account went negative, and reconciliation passes.
 *
 *   node tests/e2e/concurrency.mjs            (defaults: 20 accounts, 1500 transfers, 64 in flight)
 *   TRANSFERS=5000 CONCURRENCY=128 node tests/e2e/concurrency.mjs
 */
import { assert, call, createFundedAccounts, must, percentile, pool } from './lib.mjs';

const ACCOUNTS = Number(process.env.ACCOUNTS ?? 20);
const TRANSFERS = Number(process.env.TRANSFERS ?? 1500);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 64);
const INITIAL = 50_000;
const run = Date.now().toString(36);

console.log(`Setting up ${ACCOUNTS} accounts with ${INITIAL} each…`);
const accounts = await createFundedAccounts(ACCOUNTS, INITIAL);

const attempts = Array.from({ length: TRANSFERS }, (_, i) => {
  const from = accounts[Math.floor(Math.random() * ACCOUNTS)];
  let to = from;
  while (to === from) to = accounts[Math.floor(Math.random() * ACCOUNTS)];
  return { key: `e2e-${run}-${i}`, from, to, amount: 1 + Math.floor(Math.random() * 20_000) };
});

const tasks = attempts.flatMap((a) => [0, 1].map(() => () =>
  call('POST', '/transfers', { key: a.key, body: { fromAccountId: a.from, toAccountId: a.to, amount: a.amount, currency: 'USD' } })
    .then((res) => ({ a, res }))));
// The two copies of each key sit next to each other in the queue, so they are in flight together.
console.log(`Firing ${tasks.length} requests (${TRANSFERS} transfers × 2 copies), ${CONCURRENCY} in flight…`);
const started = performance.now();
const results = await pool(tasks, CONCURRENCY);
const elapsedSec = (performance.now() - started) / 1000;

const idsByKey = new Map();
const statusCounts = {};
let replayed = 0;
for (const { a, res } of results) {
  statusCounts[res.status] = (statusCounts[res.status] ?? 0) + 1;
  if (res.status === 201) {
    if (!idsByKey.has(a.key)) idsByKey.set(a.key, new Set());
    idsByKey.get(a.key).add(res.json.id);
    if (res.headers.get('idempotent-replayed') === 'true') replayed += 1;
  }
}
const latencies = results.map((r) => r.res.ms);

console.log('\nResults');
console.log(`  status codes: ${JSON.stringify(statusCounts)}`);
console.log(`  throughput:   ${(results.length / elapsedSec).toFixed(0)} req/s over ${elapsedSec.toFixed(1)}s`);
console.log(`  latency:      p50 ${percentile(latencies, 50).toFixed(1)}ms  p95 ${percentile(latencies, 95).toFixed(1)}ms  p99 ${percentile(latencies, 99).toFixed(1)}ms`);
console.log(`  committed:    ${idsByKey.size} transfers, ${replayed} replayed responses\n`);

const unexpected = Object.keys(statusCounts).filter((s) => !['201', '422'].includes(s));
assert(unexpected.length === 0, `only 201 and 422 (insufficient funds) responses, saw ${JSON.stringify(statusCounts)}`);
assert([...idsByKey.values()].every((ids) => ids.size === 1), 'every Idempotency-Key maps to exactly one transfer id');

const expected = new Map(accounts.map((id) => [id, INITIAL]));
const byKey = new Map(attempts.map((a) => [a.key, a]));
for (const key of idsByKey.keys()) {
  const a = byKey.get(key);
  expected.set(a.from, expected.get(a.from) - a.amount);
  expected.set(a.to, expected.get(a.to) + a.amount);
}

let total = 0;
let mismatches = 0;
let negative = 0;
for (const id of accounts) {
  const { balance } = await must('GET', `/accounts/${id}/balance`);
  total += balance;
  if (balance !== expected.get(id)) mismatches += 1;
  if (balance < 0) negative += 1;
}
assert(mismatches === 0, 'every balance equals the model built from successful responses');
assert(negative === 0, 'no account was overdrawn');
assert(total === INITIAL * ACCOUNTS, `money is conserved (${total} == ${INITIAL * ACCOUNTS})`);

const report = await must('POST', '/admin/reconciliation/run', { body: {} });
assert(report.ok === true, `reconciliation: sum=${report.totalSum}, unbalanced=${report.unbalancedTransfers}, mismatched=${report.mismatchedAccounts}`);

console.log(process.exitCode ? '\nCONCURRENCY TEST FAILED' : '\nCONCURRENCY TEST PASSED');
