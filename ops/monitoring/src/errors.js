/**
 * An adapter throws this when a reading is not a failure but simply not there: a URL that
 * was never configured, or a source that does not exist yet. The dashboard shows it as
 * "not configured" / "not available", never as red.
 */
export class Unavailable extends Error {
  /**
   * @param {'NOT_CONFIGURED' | 'NO_SOURCE'} code
   * @param {string} message  one fixed sentence, written by this code, never copied from a system
   */
  constructor(code, message) {
    super(message);
    this.name = 'Unavailable';
    this.code = code;
  }
}
