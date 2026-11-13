/**
 * A structural check on whatever is about to leave the process as the metrics snapshot.
 *
 * `metrics.snapshot()` (jobs/metrics.js) is counts and durations by design: sessions are a bounded
 * set of ids that is never exposed, and nothing records a document, a prompt or a ticket. This guard
 * does not rely on that staying true. It admits only the shapes a counts-only snapshot can have, so a
 * field added carelessly later (a list of session ids, a message, a token) makes the snapshot be
 * refused instead of served.
 *
 * Admitted: plain objects, finite numbers, booleans, null, and ISO-8601 timestamps. Not admitted:
 * arrays (no lists of anything), any other string, odd key names, deep nesting, anything large.
 */

export const MAX_SNAPSHOT_BYTES = 64 * 1024;
const MAX_DEPTH = 6;
const MAX_KEYS = 600;

const KEY = /^[A-Za-z0-9_]{1,80}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export class SnapshotInvalidError extends Error {
  /** @param {string} reason a fixed phrase naming the rule that failed; never the offending value */
  constructor(reason) {
    super(`snapshot refused: ${reason}`);
    this.name = 'SnapshotInvalidError';
    this.code = 'SNAPSHOT_INVALID';
    this.reason = reason;
  }
}

/** A fixed status identifier such as `gateway_offline`: lowercase words, never free text. */
const IDENTIFIER = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * @param {unknown} value
 * @param {{ identifiers?: boolean }} [options]  also admit short lowercase identifiers as text (the
 *   Apayee view's status code). The job snapshot never needs them and does not pass this.
 * @returns {string} the snapshot as JSON, ready to send
 * @throws {SnapshotInvalidError}
 */
export function serializeSnapshot(value, { identifiers = false } = {}) {
  let keys = 0;

  const visit = (node, depth) => {
    if (depth > MAX_DEPTH) throw new SnapshotInvalidError('nested too deeply');
    if (node === null || typeof node === 'boolean') return;
    // A number that is not finite (an empty event-loop histogram reads NaN in the first moments after
    // boot) is sent as `null` by JSON.stringify: "no value yet", which is true. It is not a reason to
    // refuse the whole snapshot, and the monitor reads null as "not available", never as zero.
    if (typeof node === 'number') return;
    if (typeof node === 'string') {
      if (ISO.test(node) || (identifiers && IDENTIFIER.test(node))) return;
      throw new SnapshotInvalidError('a text value is not a timestamp');
    }
    if (Array.isArray(node)) throw new SnapshotInvalidError('a list is not allowed');
    if (typeof node === 'object') {
      const prototype = Object.getPrototypeOf(node);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new SnapshotInvalidError('not a plain object');
      }
      for (const [key, child] of Object.entries(node)) {
        keys += 1;
        if (keys > MAX_KEYS) throw new SnapshotInvalidError('too many fields');
        if (!KEY.test(key))
          throw new SnapshotInvalidError('a field name is not a plain identifier');
        visit(child, depth + 1);
      }
      return;
    }
    throw new SnapshotInvalidError('an unsupported value type');
  };

  if (value === null || typeof value !== 'object') {
    throw new SnapshotInvalidError('the snapshot is not an object');
  }
  visit(value, 0);

  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > MAX_SNAPSHOT_BYTES) throw new SnapshotInvalidError('too large');
  return json;
}
