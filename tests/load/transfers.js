// k6 load test against the gateway: constant arrival rate of POST /v1/transfers.
//   docker compose --profile load run --rm k6
//   docker compose --profile load run --rm -e RATE=500 -e DURATION=2m k6
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const API_KEY = __ENV.API_KEY || 'sk_test_load';
const RATE = Number(__ENV.RATE || 200);
const DURATION = __ENV.DURATION || '60s';
const ACCOUNTS = Number(__ENV.ACCOUNTS || 50);

const headers = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };
const insufficientFunds = new Counter('insufficient_funds');

export const options = {
  scenarios: {
    transfers: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.max(50, RATE / 2),
      maxVUs: RATE * 2,
    },
  },
  thresholds: {
    'http_req_failed{name:transfer}': ['rate<0.01'],
    'http_req_duration{name:transfer}': ['p(95)<250', 'p(99)<500'],
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  const ids = [];
  for (let i = 0; i < ACCOUNTS; i += 1) {
    const acct = http.post(`${BASE_URL}/v1/accounts`, JSON.stringify({ name: `k6-${i}`, currency: 'USD' }), { headers });
    const id = acct.json('id');
    http.post(`${BASE_URL}/v1/deposits`, JSON.stringify({ accountId: id, amount: 1_000_000_000 }),
      { headers: { ...headers, 'Idempotency-Key': `k6-seed-${Date.now()}-${i}` } });
    ids.push(id);
  }
  return { ids };
}

export default function ({ ids }) {
  const from = ids[Math.floor(Math.random() * ids.length)];
  let to = from;
  while (to === from) to = ids[Math.floor(Math.random() * ids.length)];

  const res = http.post(
    `${BASE_URL}/v1/transfers`,
    JSON.stringify({ fromAccountId: from, toAccountId: to, amount: 1 + Math.floor(Math.random() * 1000), currency: 'USD' }),
    { headers: { ...headers, 'Idempotency-Key': `k6-${__VU}-${__ITER}-${Date.now()}` }, tags: { name: 'transfer' } },
  );
  if (res.status === 422) insufficientFunds.add(1);
  check(res, { 'status is 201': (r) => r.status === 201 });
}

export function teardown() {
  const recon = http.post(`${BASE_URL}/v1/admin/reconciliation/run`, '{}', { headers });
  check(recon, { 'ledger reconciles after load': (r) => r.json('ok') === true });
}

export function handleSummary(data) {
  const d = data.metrics['http_req_duration{name:transfer}'] || data.metrics.http_req_duration;
  const reqs = data.metrics.http_reqs.values;
  const lines = [
    '',
    `transfers/s (all requests): ${reqs.rate.toFixed(1)}`,
    `latency ms  p50 ${d.values.med.toFixed(1)}  p95 ${d.values['p(95)'].toFixed(1)}  p99 ${d.values['p(99)'].toFixed(1)}  max ${d.values.max.toFixed(1)}`,
    `failed: ${(data.metrics.http_req_failed.values.rate * 100).toFixed(2)}%`,
    '',
  ];
  return {
    stdout: lines.join('\n'),
    '/scripts/results/summary.json': JSON.stringify(data, null, 2),
  };
}
