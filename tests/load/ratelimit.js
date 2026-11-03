// Shows the token bucket working: the demo key allows 20 req/s with a burst of 40.
// Driving it at 100 req/s should give roughly 20% 200s and 80% 429s, each 429 carrying Retry-After.
//   docker compose --profile load run --rm k6 run /scripts/ratelimit.js
import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const limited = new Rate('rate_limited');

export const options = {
  scenarios: {
    burst: { executor: 'constant-arrival-rate', rate: 100, timeUnit: '1s', duration: '20s', preAllocatedVUs: 50 },
  },
};

export default function () {
  const res = http.get(`${BASE_URL}/v1/accounts`, { headers: { Authorization: 'Bearer sk_test_demo' } });
  limited.add(res.status === 429);
  check(res, {
    'allowed or limited': (r) => r.status === 200 || r.status === 429,
    '429 carries Retry-After': (r) => r.status !== 429 || r.headers['Retry-After'] !== undefined,
  });
}
