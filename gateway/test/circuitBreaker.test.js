import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CircuitBreaker, State } from '../src/circuitBreaker.js';

function breaker(overrides = {}) {
  let now = 0;
  const changes = [];
  const b = new CircuitBreaker('ledger', {
    windowMs: 10_000, minRequests: 4, failureRate: 0.5, cooldownMs: 5000,
    now: () => now, onStateChange: (e) => changes.push(`${e.from}->${e.to}`), ...overrides,
  });
  return { b, changes, advance: (ms) => { now += ms; } };
}

test('stays closed below the minimum request volume', () => {
  const { b } = breaker();
  for (let i = 0; i < 3; i += 1) {
    assert.equal(b.allowRequest(), true);
    b.onFailure();
  }
  assert.equal(b.state, State.CLOSED);
});

test('opens when the failure rate crosses the threshold and then fails fast', () => {
  const { b, changes } = breaker();
  b.onSuccess();
  b.onSuccess();
  b.onFailure();
  b.onFailure();
  assert.equal(b.state, State.OPEN);
  assert.equal(b.allowRequest(), false);
  assert.equal(b.retryAfterMs(), 5000);
  assert.deepEqual(changes, ['CLOSED->OPEN']);
});

test('after the cooldown exactly one probe is allowed', () => {
  const { b, advance } = breaker();
  for (let i = 0; i < 4; i += 1) b.onFailure();
  advance(5000);
  assert.equal(b.allowRequest(), true);
  assert.equal(b.state, State.HALF_OPEN);
  assert.equal(b.allowRequest(), false, 'second concurrent probe must be rejected');
});

test('successful probe closes the circuit with a clean window', () => {
  const { b, advance, changes } = breaker();
  for (let i = 0; i < 4; i += 1) b.onFailure();
  advance(5000);
  b.allowRequest();
  b.onSuccess();
  assert.equal(b.state, State.CLOSED);
  assert.equal(b.stats().total, 0);
  assert.deepEqual(changes, ['CLOSED->OPEN', 'OPEN->HALF_OPEN', 'HALF_OPEN->CLOSED']);
});

test('failed probe re-opens and restarts the cooldown', () => {
  const { b, advance } = breaker();
  for (let i = 0; i < 4; i += 1) b.onFailure();
  advance(5000);
  b.allowRequest();
  b.onFailure();
  assert.equal(b.state, State.OPEN);
  advance(4999);
  assert.equal(b.allowRequest(), false);
  advance(1);
  assert.equal(b.allowRequest(), true);
});

test('old failures age out of the rolling window', () => {
  const { b, advance } = breaker();
  b.onFailure();
  b.onFailure();
  b.onFailure();
  advance(11_000);
  b.onFailure();
  b.onSuccess();
  b.onSuccess();
  b.onSuccess();
  assert.equal(b.state, State.CLOSED);
  assert.deepEqual(b.stats(), { total: 4, failures: 1 });
});
