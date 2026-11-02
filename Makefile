.PHONY: up down logs ps test test-ledger test-unit e2e chaos load ratelimit

up:            ## build and start everything; dashboard on :8000, API on :3000
	docker compose up -d --build
	@echo "Dashboard: http://localhost:8000   API: http://localhost:3000"

down:          ## stop and delete all data
	docker compose down -v

logs:
	docker compose logs -f --tail=100

ps:
	docker compose ps

test: test-unit test-ledger

test-ledger:   ## ledger integration tests (concurrency, idempotency, outbox) against real Postgres
	docker compose up -d postgres
	docker compose --profile test run --rm ledger-test

test-unit:     ## webhook signing/backoff/SSRF + gateway breaker/token bucket (needs Node 22 locally)
	cd webhook-service && npm install --no-audit --no-fund && npm test
	cd gateway && npm install --no-audit --no-fund && npm test

e2e:           ## 1,500 concurrent transfers x2 through the gateway (stack must be up)
	node tests/e2e/concurrency.mjs

chaos:         ## kill the webhook receiver mid-run and prove every event is delivered
	node tests/e2e/chaos.mjs

load:          ## k6: throughput and p99 latency of POST /v1/transfers
	mkdir -p tests/load/results
	docker compose --profile load run --rm k6

ratelimit:     ## k6: drive the demo key past its rate limit
	docker compose --profile load run --rm k6 run /scripts/ratelimit.js
