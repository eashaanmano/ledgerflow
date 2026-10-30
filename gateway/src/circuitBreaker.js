/*
 * CLOSED    -> requests flow; outcomes are recorded in a rolling window.
 *              Trips to OPEN when the window has >= minRequests and the failure rate >= failureRate.
 * OPEN      -> requests are rejected immediately (no load on a struggling upstream).
 *              After cooldownMs the next caller is let through as a probe (HALF_OPEN).
 * HALF_OPEN -> exactly one probe in flight. Success closes the circuit, failure re-opens it.
 */
export const State = Object.freeze({ CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' });

export class CircuitBreaker {
  constructor(name, { windowMs = 10_000, minRequests = 10, failureRate = 0.5, cooldownMs = 5000, now = Date.now, onStateChange = () => {} } = {}) {
    Object.assign(this, { name, windowMs, minRequests, failureRate, cooldownMs, now, onStateChange });
    this.state = State.CLOSED;
    this.outcomes = [];
    this.openedAt = 0;
    this.probeInFlight = false;
  }

  /** Returns true if the caller may send a request. Callers that get true must report the outcome. */
  allowRequest() {
    if (this.state === State.CLOSED) return true;
    if (this.state === State.OPEN) {
      if (this.now() - this.openedAt < this.cooldownMs) return false;
      this.#transition(State.HALF_OPEN);
    }
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  onSuccess() {
    if (this.state === State.HALF_OPEN) {
      this.probeInFlight = false;
      this.outcomes = [];
      this.#transition(State.CLOSED);
      return;
    }
    this.#record(true);
  }

  onFailure() {
    if (this.state === State.HALF_OPEN) {
      this.probeInFlight = false;
      this.#open();
      return;
    }
    this.#record(false);
    const { total, failures } = this.stats();
    if (this.state === State.CLOSED && total >= this.minRequests && failures / total >= this.failureRate) {
      this.#open();
    }
  }

  retryAfterMs() {
    return this.state === State.OPEN ? Math.max(0, this.cooldownMs - (this.now() - this.openedAt)) : 0;
  }

  stats() {
    this.#prune();
    const failures = this.outcomes.filter((o) => !o.ok).length;
    return { total: this.outcomes.length, failures };
  }

  snapshot() {
    return { name: this.name, state: this.state, ...this.stats(), retryAfterMs: this.retryAfterMs() };
  }

  #record(ok) {
    this.outcomes.push({ t: this.now(), ok });
    this.#prune();
  }

  #prune() {
    const cutoff = this.now() - this.windowMs;
    let i = 0;
    while (i < this.outcomes.length && this.outcomes[i].t < cutoff) i += 1;
    if (i > 0) this.outcomes.splice(0, i);
  }

  #open() {
    this.openedAt = this.now();
    this.#transition(State.OPEN);
  }

  #transition(to) {
    if (this.state === to) return;
    const from = this.state;
    this.state = to;
    this.onStateChange({ name: this.name, from, to });
  }
}
