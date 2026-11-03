/**
 * A sliding-window request counter with a bounded number of keys.
 *
 * One bucket per key (a ticket's `sid`, a client address). A limit of 0 turns the
 * limiter off. The key table is capped: when it is full the least recently used key
 * is forgotten, so a flood of new keys cannot grow memory without bound. Forgetting a
 * key forgets its history, which can only make the limiter more lenient for that key,
 * never stricter.
 *
 * In memory, per process, reset by a restart: a brake, not a billing control.
 */
export class SlidingWindowLimiter {
  #hits = new Map();
  #limit;
  #windowMs;
  #maxKeys;
  #now;

  /**
   * @param {object} options
   * @param {number} options.limit      hits allowed per window; 0 disables the limiter
   * @param {number} options.windowMs
   * @param {number} [options.maxKeys]
   * @param {() => number} [options.now]
   */
  constructor({ limit, windowMs, maxKeys = 10_000, now = Date.now }) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#maxKeys = maxKeys;
    this.#now = now;
  }

  /**
   * Counts one hit for the key, or refuses it.
   *
   * @param {string} key
   * @returns {{ ok: true } | { ok: false, retryAfterMs: number }}
   */
  hit(key) {
    if (this.#limit <= 0) return { ok: true };

    const now = this.#now();
    const since = now - this.#windowMs;
    const times = (this.#hits.get(key) ?? []).filter((time) => time > since);

    // Re-inserted so the Map's order is least-recently-used first.
    this.#hits.delete(key);

    if (times.length >= this.#limit) {
      this.#hits.set(key, times);
      this.#trim();
      return { ok: false, retryAfterMs: Math.max(1, times[0] + this.#windowMs - now) };
    }

    times.push(now);
    this.#hits.set(key, times);
    this.#trim();
    return { ok: true };
  }

  #trim() {
    while (this.#hits.size > this.#maxKeys) {
      this.#hits.delete(this.#hits.keys().next().value);
    }
  }

  /** For tests and metrics. */
  get size() {
    return this.#hits.size;
  }
}
