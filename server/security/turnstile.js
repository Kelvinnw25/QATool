import { createHash } from 'node:crypto';

/**
 * Cloudflare Turnstile, verified on the server.
 *
 * The widget in the visitor's browser produces a token; only Cloudflare can say
 * whether it is genuine, so this calls Cloudflare's `siteverify` and then checks the
 * answer against what this deployment expects:
 *
 *  - `success` is true,
 *  - `hostname` is one of the hostnames the widget is allowed to run on,
 *  - `action` is the action the frontend sets,
 *  - `challenge_ts` is recent (and not in the future).
 *
 * It fails closed. A network error, a timeout, a non-2xx answer or a reply that is
 * not the documented JSON is "unavailable", never "passed".
 *
 * A token is single use. Cloudflare rejects a second use itself, and this keeps a
 * bounded in-memory set of the tokens it has seen as well, so a replay is refused
 * without another round trip and a flood of replays cannot be used to make this
 * server hammer Cloudflare. The set holds hashes, never the tokens.
 */

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Cloudflare's tokens are at most 2048 characters. */
const MAX_TOKEN_CHARS = 2048;

/** Allowance for clock drift between Cloudflare and this PC. */
const FUTURE_SKEW_MS = 60_000;

export class TurnstileError extends Error {
  /** @param {'invalid' | 'replay' | 'hostname' | 'action' | 'stale' | 'unavailable'} kind */
  constructor(kind) {
    super(`Turnstile verification failed: ${kind}`);
    this.name = 'TurnstileError';
    this.kind = kind;
  }
}

/**
 * Remembers recently seen tokens, bounded in size and in time.
 *
 * Entries live for `ttlMs`, comfortably longer than a token's own 300 seconds. When
 * full, the oldest entry is dropped: Cloudflare's own single-use rule still covers
 * the token that fell out, so the cap never turns into a way to reuse one.
 */
export function createReplayCache({
  ttlMs = 10 * 60_000,
  maxEntries = 10_000,
  now = Date.now,
} = {}) {
  /** hash -> expiry; insertion order is expiry order because the ttl is constant */
  const seen = new Map();

  function purge() {
    const time = now();
    for (const [hash, expiry] of seen) {
      if (expiry > time) break;
      seen.delete(hash);
    }
  }

  return {
    /** @returns {boolean} false when the token has been seen */
    claim(hash) {
      purge();
      if (seen.has(hash)) return false;
      while (seen.size >= maxEntries) seen.delete(seen.keys().next().value);
      seen.set(hash, now() + ttlMs);
      return true;
    },
    release(hash) {
      seen.delete(hash);
    },
    get size() {
      return seen.size;
    },
  };
}

/**
 * The real call to Cloudflare. Replaced by a fake in tests; nothing else in the
 * system talks to Cloudflare.
 *
 * @param {{ secret: string, response: string }} body
 * @param {{ timeoutMs: number }} options
 * @returns {Promise<object>} the parsed JSON reply
 */
export async function siteverifyOverHttp({ secret, response }, { timeoutMs }) {
  const reply = await fetch(SITEVERIFY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret, response }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!reply.ok) throw new Error(`siteverify answered ${reply.status}`);
  return reply.json();
}

/**
 * @param {object} options
 * @param {string} options.secret
 * @param {string[]} options.hostnames   lower case
 * @param {string} options.action
 * @param {number} [options.maxAgeMs]
 * @param {number} [options.timeoutMs]
 * @param {typeof siteverifyOverHttp} [options.siteverify]  injected in tests
 * @param {ReturnType<typeof createReplayCache>} [options.replay]
 * @param {() => number} [options.now]
 */
export function createTurnstileVerifier({
  secret,
  hostnames,
  action,
  maxAgeMs = 5 * 60_000,
  timeoutMs = 5_000,
  siteverify = siteverifyOverHttp,
  replay,
  now = Date.now,
}) {
  const seen = replay ?? createReplayCache({ now });
  const allowedHosts = new Set(hostnames.map((host) => host.toLowerCase()));

  return {
    /**
     * @param {unknown} token
     * @throws {TurnstileError}
     */
    async verify(token) {
      if (typeof token !== 'string' || token === '' || token.length > MAX_TOKEN_CHARS) {
        throw new TurnstileError('invalid');
      }

      const hash = createHash('sha256').update(token).digest('hex');
      if (!seen.claim(hash)) throw new TurnstileError('replay');

      let result;
      try {
        result = await siteverify({ secret, response: token }, { timeoutMs });
      } catch {
        // Cloudflare was not reached, so the token was not spent: let it be tried again.
        seen.release(hash);
        throw new TurnstileError('unavailable');
      }

      if (result === null || typeof result !== 'object' || Array.isArray(result)) {
        seen.release(hash);
        throw new TurnstileError('unavailable');
      }

      // Cloudflare says the validation itself failed, not the visitor.
      const codes = Array.isArray(result['error-codes']) ? result['error-codes'] : [];
      if (result.success !== true && codes.includes('internal-error')) {
        seen.release(hash);
        throw new TurnstileError('unavailable');
      }

      if (result.success !== true) throw new TurnstileError('invalid');

      const host = typeof result.hostname === 'string' ? result.hostname.toLowerCase() : '';
      if (!allowedHosts.has(host)) throw new TurnstileError('hostname');

      if (result.action !== action) throw new TurnstileError('action');

      const issued =
        typeof result.challenge_ts === 'string' ? Date.parse(result.challenge_ts) : NaN;
      const age = now() - issued;
      if (!Number.isFinite(issued) || age > maxAgeMs || age < -FUTURE_SKEW_MS) {
        throw new TurnstileError('stale');
      }
    },
  };
}
