import { AppError } from '../lib/errors.js';
import { SlidingWindowLimiter } from './limiter.js';
import { TurnstileError } from './turnstile.js';

/**
 * Minting a visitor session: Turnstile in, ticket out.
 *
 * The only unauthenticated step in the demo, so it is the one place that needs its
 * own backstop. The backstop is keyed by client address and is deliberately LOOSE: a
 * whole room can share one address, and a limit that bites there would lock out the
 * audience. It exists to make a script that mints tickets in a loop slow, not to
 * identify anyone. Through an untrusted peer the "address" is the proxy's (network.js)
 * and the limit becomes a global one, which is still the right order of magnitude.
 *
 * The ticket's identity never comes from the caller: `sid` is generated in
 * ticket.js. The address is not stored in the ticket.
 *
 * Failures are three kinds and no more, whatever Cloudflare said:
 *   400 TURNSTILE_FAILED       the check did not pass (invalid, replayed, wrong site...)
 *   503 CHALLENGE_UNAVAILABLE  the check could not be completed; try again
 *   429 RATE_LIMITED           too many tickets from this address
 */

/**
 * @param {object} options
 * @param {{ verify: (token: unknown) => Promise<void> }} options.verifier
 * @param {{ mint: (options: { origin: string }) => Promise<{ ticket: string, sid: string, expiresAt: number }> }} options.tickets
 * @param {(request: object) => { peer: string, client: string }} options.clientAddress
 * @param {number} options.mintPerMinutePerIp
 * @param {{ inc: (name: string) => void, touchSession: (sid: string) => void }} [options.metrics]
 * @param {() => number} [options.now]
 */
export function createSessionService({
  verifier,
  tickets,
  clientAddress,
  mintPerMinutePerIp,
  metrics,
  now = Date.now,
}) {
  const limiter = new SlidingWindowLimiter({
    limit: mintPerMinutePerIp,
    windowMs: 60_000,
    maxKeys: 5_000,
    now,
  });

  return {
    /**
     * @param {import('fastify').FastifyRequest} request
     * @param {unknown} token  the Turnstile response from the widget
     */
    async mint(request, token) {
      const origin = request.headers.origin;
      if (typeof origin !== 'string' || origin === '') {
        // The origin hook runs first and refuses this; kept so the service is safe alone.
        throw new AppError('ORIGIN_FORBIDDEN', 'This origin may not use the API.', 403);
      }

      const allowance = limiter.hit(clientAddress(request).client);
      if (!allowance.ok) {
        metrics?.inc('session_rate_limited');
        throw Object.assign(
          new AppError('RATE_LIMITED', 'Too many sessions were requested. Wait, then retry.', 429),
          { retryAfterSeconds: Math.max(1, Math.ceil(allowance.retryAfterMs / 1000)) }
        );
      }

      try {
        await verifier.verify(token);
      } catch (cause) {
        if (!(cause instanceof TurnstileError)) throw cause;
        metrics?.inc(`ticket_failed_${cause.kind}`);

        if (cause.kind === 'unavailable') {
          throw Object.assign(
            new AppError(
              'CHALLENGE_UNAVAILABLE',
              'The verification service could not be reached. Try again in a moment.',
              503
            ),
            { retryAfterSeconds: 5 }
          );
        }
        throw new AppError(
          'TURNSTILE_FAILED',
          'The verification did not pass. Reload the page and try again.',
          400
        );
      }

      const minted = await tickets.mint({ origin });
      metrics?.inc('tickets_minted');
      metrics?.touchSession(minted.sid);
      return minted;
    },
  };
}
