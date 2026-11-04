# LedgerFlow

A small Stripe-style payments backend. Clients move money between accounts through a double-entry ledger, and every change is pushed to their servers as signed, retried webhooks.

```
React dashboard ──► Node API gateway ──► Spring Boot ledger ──► Postgres
                        │                       │ (outbox table)
                        │ SSE                   ▼
                        └────────────────── Redis Streams
                                                ▼
                                      Node webhook service ──► customer endpoints
```

| Service | Stack | Role |
|---|---|---|
| `ledger-service` | Java 21, Spring Boot 3, Postgres | Double-entry ledger, idempotent transfers, transactional outbox, reconciliation |
| `webhook-service` | Node 22, Postgres, Redis Streams | Endpoint registry, HMAC signing, retries with backoff + jitter, dead-letter queue, delivery log |
| `gateway` | Node 22, Redis | API key / JWT auth, Lua token-bucket rate limiting, circuit breakers, request-ID tracing, SSE feed |
| `dashboard` | React 18, TypeScript, Vite | Accounts, transfers, live event feed, webhook deliveries with replay |
| `mock-receiver` | Node 22 | A customer endpoint you can switch into failure modes or kill |

## Run it

Requires Docker. Node 22 is only needed for the unit and end-to-end test scripts.

```bash
make up                 # or: docker compose up -d --build
```

- Dashboard: http://localhost:8000 (sign in with `sk_test_demo`)
- API: http://localhost:3000

```bash
KEY=sk_test_demo
A=$(curl -s -X POST localhost:3000/v1/accounts -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"name":"alice","currency":"USD"}' | jq -r .id)
B=$(curl -s -X POST localhost:3000/v1/accounts -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"name":"bob","currency":"USD"}' | jq -r .id)
curl -s -X POST localhost:3000/v1/deposits -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -H "Idempotency-Key: seed-1" -d "{\"accountId\":\"$A\",\"amount\":100000}"

# Run this twice: the second call returns the same transfer with Idempotent-Replayed: true
curl -si -X POST localhost:3000/v1/transfers -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: pay-001" -d "{\"fromAccountId\":\"$A\",\"toAccountId\":\"$B\",\"amount\":2500,\"currency\":\"USD\"}"
```

Amounts are integers in minor units (2500 = 25.00).

### Five-minute demo

1. Create two accounts, fund one, send a transfer. It appears in **Live events** as soon as the outbox relay publishes it.
2. Click **Send 3× with same key**. Three concurrent requests, one transfer, money moved once.
3. In **Webhooks**, register the mock receiver, then switch it to **Down (500)**.
4. Send a few transfers. Deliveries sit in `pending` with growing attempt counts and backoff times. Open one to see the attempt log.
5. Switch the receiver back to **Healthy**. Pending deliveries drain on their next attempt. Anything that exhausted its 8 attempts is in `dead`; replay it with one click.
6. Click the reconciliation chip in the top bar to re-verify that the ledger balances.

## Proof work

| Command | What it proves |
|---|---|
| `make test-ledger` | JUnit against real Postgres: 1,200 random transfers each fired twice concurrently (2,400 requests, 32 threads); 1,000 opposing A→B / B→A transfers with zero deadlocks; 50 concurrent retries of one key creating one transfer; overdraft rejection; one outbox event per committed transfer |
| `make test-unit` | Signature verification (tampering, wrong secret, replay window, forged timestamps), backoff bounds and jitter spread, SSRF address blocking, delivery timeouts, circuit breaker state machine, Lua token bucket under 200 concurrent callers |
| `make e2e` | 1,500 transfers × 2 copies through the gateway; balances match a model built from responses, money conserved, nothing overdrawn, reconciliation clean |
| `make chaos` | Kills the receiver container mid-burst, leaves it down 20s, restarts it, and waits until every transfer's webhook has arrived; checks nothing was dead-lettered and duplicates were deduplicated |
| `make load` | k6 constant-arrival-rate load on `POST /v1/transfers` (default 200/s for 60s) with p95/p99 thresholds and a reconciliation check in teardown |
| `make ratelimit` | Drives the demo key at 5× its limit to show 429s with `Retry-After` |


| Metric | Result | Hardware |
|---|---|---|
| Ledger concurrency test | | |
| e2e: requests/s, p99 | | |
| Chaos: recovery time after restart | | |
| k6: sustained transfers/s, p95, p99 | | |
| Ledger concurrency test | 1,200 transfers x 2 concurrent copies (2,400 requests, 32 threads): 1,041 committed, 1,025 idempotent replays, 334 insufficient-funds rejections, 0 errors; balances match model, reconciliation clean | AMD Ryzen 7 170, 7.4 GiB RAM (WSL2), 2026-11-04 |
| e2e: requests/s, p99 | 3,000 requests, 64 in flight on 20 hot accounts: 270 req/s, p50 217 ms, p95 351 ms, p99 482 ms (row-lock contention by design); 2,543 x 201, 457 x 422 | same |
| Chaos: recovery time after restart | Receiver killed mid-burst, down 20 s: all 302 events delivered 10.2 s after restart, 0 dead-lettered, 0 bad signatures | same |
| k6: sustained transfers/s, p95, p99 | 200 req/s constant arrival for 60 s, 50 accounts: p50 10.5 ms, p95 21.7 ms, p99 47.9 ms, 0.00% failed; ledger reconciles after load | same |

## Design decisions

**Money and double entry.** Amounts are `BIGINT` minor units, never floats. A transfer writes two journal entries with signed amounts (debit negative, credit positive) that sum to zero, so `SUM(journal_entries.amount)` over the whole table must always be 0. Deposits come from a per-currency `SYSTEM` account that may go negative, which keeps that invariant true even as money enters the system. `accounts.balance` is a cache of the journal; a `CHECK` constraint stops a user account going negative even if application code regresses.

**Idempotency.** The `Idempotency-Key` is claimed with `INSERT … ON CONFLICT DO NOTHING` *inside the transfer's transaction*, and the response is stored in the same transaction. If two requests with the same key race, Postgres blocks the second insert until the first commits, then the second sees the conflict and returns the stored response byte for byte. If the first rolls back, the second proceeds. There is no "in progress" state to get stuck in. Reusing a key with a different body returns 422. Failed requests (insufficient funds, validation) do not burn the key.

**Deadlock freedom.** Both account rows are locked with `SELECT … FOR UPDATE` in a global order (by id), so A→B and B→A transfers can never wait on each other in a cycle. The idempotency claim happens before any row lock, so waiting on a duplicate key never holds an account lock.

**Transactional outbox.** The transfer and its `transfer.completed` event are written in one transaction, so an event exists if and only if the transfer committed. A relay polls unpublished rows with `FOR UPDATE SKIP LOCKED` (safe with several ledger replicas) and `XADD`s them to a Redis Stream. A crash between `XADD` and marking the row published republishes it: delivery is at-least-once by design, and every consumer dedupes on event id.

**Webhook delivery.**
- Ingest reads the stream with a consumer group and acks only after delivery rows are durable. On start it re-reads its own pending entries; `XAUTOCLAIM` takes over entries left by a consumer that died.
- `UNIQUE (event_id, endpoint_id)` turns at-least-once input into exactly one delivery job per endpoint.
- Workers claim due jobs with a 30s lease using `SKIP LOCKED`; a worker that dies mid-request leaves a lease that expires and is picked up again.
- Retries use exponential backoff with equal jitter (1s base, 30s cap, 8 attempts: an endpoint has to stay down for roughly 45 to 90 seconds before an event is dead-lettered in the compose config). Dead rows are the dead-letter queue; replay resets the attempt budget but keeps the attempt log.
- Payloads are signed `t=<unix>,v1=HMAC_SHA256(secret, "<t>.<body>")`. Receivers reject timestamps older than 5 minutes, so a captured request cannot be replayed later, and changing `t` breaks the signature. Multiple `v1` values are accepted to allow secret rotation.
- Endpoint URLs that resolve to private or link-local addresses (including cloud metadata at 169.254.169.254) are rejected outside demo mode.

**Gateway.**
- The token bucket runs as a Lua script, so read-refill-spend is atomic across gateway replicas, and it uses Redis `TIME` so clock skew between gateway hosts cannot mint tokens. If Redis is down the limiter fails open, choosing availability for payments over strict limiting.
- Circuit breakers per upstream trip on failure rate over a rolling window (not just consecutive failures, which interleaved successes would mask), fail fast with 503 + `Retry-After` while open, and let exactly one probe through when half-open. 4xx responses do not count as failures.
- A request id is accepted or minted at the edge, forwarded to every service, written to ledger logs (MDC), stored on the transfer and the outbox event, and sent on the webhook as `X-Request-Id`. One id follows a payment from the HTTP call to the customer's server.
- The SSE feed uses one shared `XREAD` loop for all browser connections and supports `Last-Event-ID` backfill, so a reconnecting tab misses nothing. Because `EventSource` cannot set headers, it authenticates with a 15-minute JWT, never the API key.

**Reconciliation.** Every 30s, and on demand, a job checks three invariants in one `REPEATABLE READ` snapshot: the global sum is 0, every transfer has exactly two entries summing to 0, and every cached balance equals its journal sum. The snapshot matters: under `READ COMMITTED` a transfer committing between queries would show up as a false mismatch.

## Bugs found by the tests

- Idempotent replays were not byte-identical: responses were stored as `jsonb`, which reorders keys
  and rewrites whitespace. Fixed with migration `V2__idempotency_response_text.sql` (TEXT column)
  rather than editing V1, which had already been applied.

## Known limitations

These are deliberate scope cuts, and the first things to change for production:

- Deposits all lock the one system account per currency, a hot row that caps deposit throughput. Fix: shard system accounts or batch external funding.
- Reconciliation scans the full journal. Fix: incremental checks from a stored checkpoint.
- The outbox relay holds its transaction open while calling Redis. Fine at this scale; a CDC pipeline (Debezium) removes polling entirely.
- The Redis Stream is never trimmed. Fix: `XADD MAXLEN ~` once every consumer group is past an id.
- Idempotency keys never expire. Fix: a TTL job (Stripe keeps them 24 hours).
- The SSRF check runs at registration time only; DNS rebinding needs the resolved IP pinned at delivery time.
- API keys live in an env var and any authenticated client can call the admin reconciliation endpoints.
- Downstream services trust `X-Client-Id` from the gateway, which is safe only because they are not exposed outside the Docker network.

## API

All routes are under `/v1` on the gateway and take `Authorization: Bearer <api key or JWT>`. `POST /transfers` and `POST /deposits` require `Idempotency-Key`.

| Method | Path | |
|---|---|---|
| POST | `/auth/token` | Exchange an API key for a 15-minute JWT |
| POST/GET | `/accounts` | Create / list accounts |
| GET | `/accounts/{id}`, `/accounts/{id}/balance` | |
| GET | `/accounts/{id}/transactions?limit=&before=` | Journal lines, cursor-paginated |
| POST | `/transfers` | `{fromAccountId, toAccountId, amount, currency, description?}` |
| GET | `/transfers`, `/transfers/{id}` | |
| POST | `/deposits` | `{accountId, amount}` from the external funding account |
| GET | `/events/stream?access_token=` | Server-sent events |
| POST/GET | `/webhooks/endpoints` | `{url, secret?, events: ["transfer.completed" \| "account.created" \| "*"]}` |
| DELETE | `/webhooks/endpoints/{id}` | Disable |
| GET | `/webhooks/deliveries?status=&endpointId=` | Delivery log |
| GET | `/webhooks/deliveries/{id}` | Payload and every attempt |
| POST | `/webhooks/deliveries/{id}/replay` | |
| GET/POST | `/webhooks/dead-letters`, `/webhooks/dead-letters/replay` | |
| POST/GET | `/admin/reconciliation/run`, `/admin/reconciliation/latest` | |

Errors are `{"error": {"code": "...", "message": "..."}}` and every response carries `X-Request-Id`.

## Verifying a webhook (receiver side)

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(secret, rawBody, header) {
  const { t, v1 } = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  const given = Buffer.from(v1, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

Then dedupe on the `LedgerFlow-Event-Id` header: delivery is at-least-once.

## Layout

```
ledger-service/     Spring Boot app, Flyway migrations, JUnit integration tests
webhook-service/    ingest (stream consumer), dispatcher (retries), API, unit tests
gateway/            auth, Lua rate limiter, circuit breaker, proxy, SSE hub, unit tests
dashboard/          React + TypeScript UI, served by nginx
mock-receiver/      demo customer endpoint with failure modes
tests/e2e/          concurrency and chaos scripts (Node 22, no dependencies)
tests/load/         k6 scripts
infra/postgres/     database init
```

