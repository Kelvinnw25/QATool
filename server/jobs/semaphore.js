/**
 * At most `max` holders at once; the rest wait their turn, in order.
 *
 * Used for parsing uploaded documents. Parsing runs on the one thread that also
 * answers every other request, so it is serialised (or nearly): two parses at a time
 * at most. The number of waiters is bounded by the caller (the global cap on uploads
 * in flight), which is why this queue has no limit of its own.
 */
export class AsyncSemaphore {
  #max;
  #active = 0;
  #waiting = [];

  /** @param {number} max */
  constructor(max) {
    this.#max = max;
  }

  /**
   * @param {AbortSignal} [signal]  a waiter whose signal fires leaves the line
   * @returns {Promise<() => void>} release function; extra calls are ignored
   */
  acquire(signal) {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));

    if (this.#active < this.#max) {
      this.#active += 1;
      return Promise.resolve(this.#releaser());
    }

    return new Promise((resolve, reject) => {
      const waiter = {};
      const leave = () => {
        signal?.removeEventListener('abort', waiter.onAbort);
        const index = this.#waiting.indexOf(waiter);
        if (index !== -1) this.#waiting.splice(index, 1);
      };

      waiter.onAbort = () => {
        leave();
        reject(signal.reason ?? new Error('aborted'));
      };
      signal?.addEventListener('abort', waiter.onAbort, { once: true });

      waiter.grant = () => {
        leave();
        this.#active += 1;
        resolve(this.#releaser());
      };
      this.#waiting.push(waiter);
    });
  }

  #releaser() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
      this.#waiting.shift()?.grant();
    };
  }

  get state() {
    return { active: this.#active, waiting: this.#waiting.length };
  }
}
