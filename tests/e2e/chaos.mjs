/*
 * Chaos test: the customer's webhook receiver dies in the middle of a burst of transfers.
 *
 *   1. register the mock receiver as an endpoint and reset its counters
 *   2. send transfers continuously; partway through, KILL the receiver container
 *   3. keep sending while it is down, leave it down for DOWNTIME_SEC, then start it again
 *   4. wait until the receiver has seen a webhook for every single transfer
 *
 * Passes only if every transfer is delivered, nothing is dead-lettered, and duplicates
 * (expected under at-least-once) were deduplicated by the receiver.
 *
 *   node tests/e2e/chaos.mjs
 *   STOP_CMD / START_CMD override how the receiver is killed and restarted (default: docker compose).
 */
import { execSync } from 'node:child_process';
import { assert, call, createFundedAccounts, must, pool, sleep } from './lib.mjs';
import { randomUUID } from 'node:crypto';

const TRANSFERS = Number(process.env.TRANSFERS ?? 300);
const RATE = Number(process.env.RATE ?? 25);
const DOWNTIME_SEC = Number(process.env.DOWNTIME_SEC ?? 20);
const DEADLINE_SEC = Number(process.env.DEADLINE_SEC ?? 180);
const STOP_CMD = process.env.STOP_CMD ?? 'docker compose kill mock-receiver';
const START_CMD = process.env.START_CMD ?? 'docker compose start mock-receiver';
const MOCK_URL = 'http://mock-receiver:4000/hooks';

const sh = (cmd) => {
  console.log(`  $ ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
};
const stamp = () => new Date().toISOString().slice(11, 19);

console.log('Preparing receiver and endpoint…');
await must('PUT', '/mock-receiver/config', { body: { mode: 'ok' } });
await must('DELETE', '/mock-receiver/received');
const { data: endpoints } = await must('GET', '/webhooks/endpoints');
if (!endpoints.some((e) => e.active && e.url === MOCK_URL)) {
  await must('POST', '/webhooks/endpoints', { body: { url: MOCK_URL, secret: 'whsec_demo_receiver_secret', events: ['transfer.completed'] } });
}
const statsBefore = await must('GET', '/webhooks/deliveries/stats');

const [a, b] = await createFundedAccounts(2, 10_000_000);
const transferIds = [];

console.log(`[${stamp()}] Sending ${TRANSFERS} transfers at ~${RATE}/s`);
const t0 = performance.now();
const sendAll = pool(Array.from({ length: TRANSFERS }, (_, i) => async () => {
  await sleep((i / RATE) * 1000 - (performance.now() - t0));
  const res = await call('POST', '/transfers', {
    key: randomUUID(),
    body: { fromAccountId: i % 2 ? a : b, toAccountId: i % 2 ? b : a, amount: 100 + i, currency: 'USD' },
  });
  if (res.status !== 201) throw new Error(`transfer failed: ${res.status} ${JSON.stringify(res.json)}`);
  transferIds.push(res.json.id);
}), 16);

// Kill the receiver once roughly a fifth of the traffic has gone out.
await sleep((TRANSFERS / RATE) * 200);
console.log(`[${stamp()}] Killing the receiver (${transferIds.length} transfers sent so far)`);
sh(STOP_CMD);
const killedAt = Date.now();

await sendAll;
console.log(`[${stamp()}] All ${transferIds.length} transfers committed; receiver still down`);

const remaining = DOWNTIME_SEC * 1000 - (Date.now() - killedAt);
if (remaining > 0) await sleep(remaining);
console.log(`[${stamp()}] Restarting the receiver after ${((Date.now() - killedAt) / 1000).toFixed(0)}s down`);
sh(START_CMD);
const restartedAt = Date.now();

let missing = transferIds.length;
while ((Date.now() - restartedAt) / 1000 < DEADLINE_SEC) {
  await sleep(2000);
  const check = await call('POST', '/mock-receiver/received/check', { body: { transferIds } });
  if (check.status !== 200) {
    console.log(`[${stamp()}] receiver not answering yet (${check.status})`);
    continue;
  }
  missing = check.json.missing.length;
  const stats = await must('GET', '/webhooks/deliveries/stats');
  console.log(`[${stamp()}] missing ${missing}/${transferIds.length} · pending ${stats.pending + stats.delivering} · dead ${stats.dead - statsBefore.dead}`);
  if (missing === 0) break;
}

const received = await must('GET', '/mock-receiver/received');
const stats = await must('GET', '/webhooks/deliveries/stats');
console.log(`\nRecovered in ${((Date.now() - restartedAt) / 1000).toFixed(1)}s after restart`);
console.log(`Receiver: ${received.uniqueEvents} unique events, ${received.totalPosts} POSTs accepted, ${received.duplicates} duplicates deduped, ${received.badSignatures} bad signatures\n`);

assert(missing === 0, `every one of ${transferIds.length} transfers was delivered to the receiver`);
assert(stats.dead === statsBefore.dead, 'nothing was dead-lettered');
assert(received.badSignatures === 0, 'every delivery carried a valid signature');
console.log(process.exitCode ? '\nCHAOS TEST FAILED' : '\nCHAOS TEST PASSED');
