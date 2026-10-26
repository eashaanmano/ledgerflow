/*
 * Exponential backoff with "equal jitter": half of the window is fixed, half is random.
 * Pure exponential backoff makes every receiver that failed together retry together; full
 * jitter fixes that but can retry almost immediately. Equal jitter keeps a floor and spreads load.
 *
 * attempt is 1-based: the delay to wait after the Nth failed attempt.
 */
export function backoffMs(attempt, { baseMs, capMs, random = Math.random }) {
  const window = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(window / 2 + random() * (window / 2));
}

/** Upper bound on total time before an event is dead-lettered; useful for documenting the retry policy. */
export function worstCaseScheduleMs(maxAttempts, opts) {
  let total = 0;
  for (let attempt = 1; attempt < maxAttempts; attempt += 1) {
    total += backoffMs(attempt, { ...opts, random: () => 1 });
  }
  return total;
}
