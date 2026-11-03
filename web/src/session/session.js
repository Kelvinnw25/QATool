/**
 * The visitor's session: a Turnstile token goes in, a ticket comes out, and the ticket lives in
 * memory until it runs out.
 *
 * Plain JavaScript, no React, so Node can test every rule here. The page subscribes to it
 * (`useSyncExternalStore`) and shows whatever `getState()` says.
 *
 * Rules, each with a test:
 *
 *  - One mint at a time, and none while a session is already usable. Polling, navigation and a
 *    re-render never call `start`; only a fresh Turnstile token does, and a token is single use.
 *  - The ticket is never written anywhere but the ticket store (memory).
 *  - When the ticket runs out, or the backend refuses it (401), the session is `expired`, the ticket
 *    is gone, and the page must obtain a fresh Turnstile token before anything protected is called.
 *    `challenge` increments so the widget is rebuilt rather than reused: a spent token is worthless.
 *  - Nothing here assumes anything about the visitor's network address. The backend does not bind a
 *    ticket to one, and neither does this.
 */

/** Statuses: 'unverified' (nothing yet), 'verifying', 'ready', 'expired', 'failed'. */

const MINT_FAILURE_TEXT = {
  TURNSTILE_FAILED: 'The verification did not pass. Please try again.',
  RATE_LIMITED: 'Too many verification attempts from this network. Wait a moment, then try again.',
  CHALLENGE_UNAVAILABLE:
    'The verification service could not be reached by the demo server. Try again in a moment.',
};

/**
 * @param {object} deps
 * @param {{ createSession: (token: string, options?: object) => Promise<any> }} deps.api
 * @param {ReturnType<import('./ticket-store.js').createTicketStore>} deps.store
 * @param {() => number} [deps.now]
 * @param {(fn: () => void, ms: number) => unknown} [deps.setTimer]
 * @param {(handle: unknown) => void} [deps.clearTimer]
 */
export function createSessionManager({
  api,
  store,
  now = Date.now,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
}) {
  const listeners = new Set();
  let timer = null;
  let minting = false;

  let state = Object.freeze({
    status: 'unverified',
    reason: null,
    error: null,
    expiresAt: null,
    limits: null,
    pollIntervalMs: null,
    challenge: 0,
  });

  function publish(patch) {
    state = Object.freeze({ ...state, ...patch });
    for (const listener of [...listeners]) listener();
  }

  function stopTimer() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  /** A ticket that is gone, for whatever reason: the next step is a fresh Turnstile token. */
  function lose(reason) {
    stopTimer();
    if (state.status !== 'ready') return;
    publish({
      status: 'expired',
      reason,
      error: null,
      expiresAt: null,
      challenge: state.challenge + 1,
    });
  }

  // The API client clears the store on a 401, and the store clears itself on expiry.
  store.subscribe((event) => {
    if (event.type === 'cleared') lose(event.reason);
  });

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** The ticket, if the session is usable right now. */
    ticket: () => store.get(),

    /**
     * Mints a ticket from a fresh Turnstile token. Ignored while one is already being minted or a
     * session is ready, so a widget that fires twice cannot cost two tickets.
     * @returns {Promise<boolean>} whether a session is now ready
     */
    async start(turnstileToken) {
      if (minting || state.status === 'ready') return state.status === 'ready';
      if (typeof turnstileToken !== 'string' || turnstileToken === '') return false;

      minting = true;
      publish({ status: 'verifying', error: null });

      try {
        const reply = await api.createSession(turnstileToken);
        const expiresAt = Date.parse(reply.expires_at);
        if (typeof reply.ticket !== 'string' || !Number.isFinite(expiresAt)) {
          throw Object.assign(new Error('The session reply was not understood.'), {
            code: 'BAD_SESSION_REPLY',
          });
        }

        store.set(reply.ticket, expiresAt);
        stopTimer();
        timer = setTimer(() => store.get(), Math.max(0, expiresAt - now()) + 50);
        publish({
          status: 'ready',
          reason: null,
          error: null,
          expiresAt,
          limits: reply.limits ?? null,
          pollIntervalMs: reply.poll_interval_ms ?? null,
        });
        return true;
      } catch (cause) {
        publish({
          status: 'failed',
          error: {
            code: cause.code ?? 'UNKNOWN',
            message:
              MINT_FAILURE_TEXT[cause.code] ??
              (cause.networkFailure || cause.unanswered
                ? cause.message
                : 'A session could not be started. Please try again.'),
            retryAfterSeconds: cause.retryAfterSeconds ?? null,
          },
          // The token is spent whether or not it worked; the widget must be rebuilt.
          challenge: state.challenge + 1,
        });
        return false;
      } finally {
        minting = false;
      }
    },

    /** Test and teardown helper: forget the ticket and any pending expiry. */
    dispose() {
      stopTimer();
      store.clear('reset');
    },
  };
}
