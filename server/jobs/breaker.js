import { ProviderUnavailableError } from '../llm/catalog.js';

/**
 * The provider breaker: stop asking a provider that has just said it cannot answer.
 *
 * When Apayee reports its provider is not ready (signed out, disabled) or out of
 * allowance (a usage limit that can take hours to clear), every job behind the one
 * that found out would find out the same way, each spending a call to learn it. The
 * breaker opens for a cooldown instead: new jobs are refused at the door with a
 * retryable "paused", and queued jobs wait rather than start. It closes by itself.
 *
 * Nothing is retried, and the breaker never decides anything about the failed job:
 * that job fails with the provider's answer, and it is the next one that waits.
 */

/** Apayee codes that mean "the provider cannot answer now", not "this one call failed". */
const OUTAGE_CODES = new Set(['PROVIDER_NOT_READY', 'PROVIDER_RATE_LIMITED']);

/**
 * Whether an error says the provider is down or out of allowance.
 * `upstreamCode` is set by the Apayee adapter (llm/apayee.js); a ProviderUnavailableError
 * is the catalog saying the gateway is not ready, before any call was made.
 */
export function isProviderOutage(error) {
  return error instanceof ProviderUnavailableError || OUTAGE_CODES.has(error?.upstreamCode);
}

/**
 * @param {object} options
 * @param {number} options.cooldownMs
 * @param {() => number} [options.now]
 * @param {() => void} [options.onTrip]  e.g. a metrics counter
 */
export function createProviderBreaker({ cooldownMs, now = Date.now, onTrip }) {
  let openUntil = 0;

  return {
    /** Opens (or extends) the breaker for one cooldown from now. */
    trip() {
      openUntil = now() + cooldownMs;
      onTrip?.();
    },
    get open() {
      return now() < openUntil;
    },
    retryAfterMs() {
      return Math.max(0, openUntil - now());
    },
    /** For tests and operators. */
    reset() {
      openUntil = 0;
    },
  };
}
