/**
 * Which pipeline run is the current one, and what it was started with.
 *
 * A run is the three calls - extract, generate, validate - made for one press of
 * Process. Everything about it that must not change midway is fixed here, when
 * it begins: the model above all. The record is frozen, so nothing a component
 * does later can swap the provider under a run; the only way to use a different
 * one is to begin another run.
 *
 * Beginning a run, or abandoning the workflow, also retires every earlier id.
 * Calls from a retired run are still in flight when that happens, and
 * isCurrent() is how their continuations find out that nobody wants the answer.
 * Plain JavaScript so Node can test it without a browser.
 */
export class RunLedger {
  #latest = 0;

  /**
   * @param {{ provider: string | null, label: string }} choice  provider is a catalog
   *   id, or null for "whatever the server is configured with"
   */
  begin({ provider, label }) {
    this.#latest += 1;
    return Object.freeze({ id: this.#latest, provider, label, active: true });
  }

  /** Retires the current run without starting another. */
  retire() {
    this.#latest += 1;
  }

  /** Ids start at 1, so 0 - what a page without a run reads - is never current. */
  isCurrent(id) {
    return id > 0 && id === this.#latest;
  }
}

/** The same run with its activity flag changed. The provider cannot change here. */
export function withActivity(run, active) {
  return Object.freeze({ ...run, active });
}
