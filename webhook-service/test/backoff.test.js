import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backoffMs, worstCaseScheduleMs } from '../src/backoff.js';

const opts = { baseMs: 1000, capMs: 60_000 };

test('delay stays within [window/2, window] and the window doubles', () => {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const window = 1000 * 2 ** (attempt - 1);
    assert.equal(backoffMs(attempt, { ...opts, random: () => 0 }), window / 2);
    assert.equal(backoffMs(attempt, { ...opts, random: () => 1 }), window);
  }
});

test('delay is capped', () => {
  assert.equal(backoffMs(20, { ...opts, random: () => 1 }), 60_000);
  assert.equal(backoffMs(20, { ...opts, random: () => 0 }), 30_000);
});

test('jitter spreads simultaneous retries apart', () => {
  const samples = new Set(Array.from({ length: 200 }, () => backoffMs(5, opts)));
  assert.ok(samples.size > 100, `expected spread, got ${samples.size} distinct delays`);
});

test('worst-case schedule for 8 attempts is about 2 minutes', () => {
  // 1 + 2 + 4 + 8 + 16 + 32 + 60 seconds between the 8 attempts
  assert.equal(worstCaseScheduleMs(8, opts), 123_000);
});
