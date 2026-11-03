import { randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

import { AppError } from '../lib/errors.js';
import { currentRun, recordFacts, trace } from '../lib/trace.js';
import { classifyFailure, identityLabel } from './access.js';

/**
 * The visitor's ticket: a short-lived signed token that says "a Turnstile check
 * passed for this session", and nothing else.
 *
 *  - HS256 with a server secret, verified with the algorithm pinned, so a token
 *    cannot choose how it is checked (`none`, RS256 and every other algorithm are
 *    refused).
 *  - Claims: `sid` (random, minted here), `iss`, `aud`, `iat`, `exp`. All required.
 *  - `aud` is the frontend origin the ticket was issued to, and is compared with the
 *    request's Origin on every use, so a ticket does not work from another site.
 *  - Never bound to a client address. Visitors share Wi-Fi and change networks; the
 *    address is used only as a loose backstop when a ticket is minted (session.js).
 *  - Sent as `Authorization: Bearer`. There are no cookies, so there is nothing for
 *    a cross-site page to ride.
 *
 * The `sid` is the only identity the rest of the system sees. It comes from this
 * file and from nowhere a caller can write to: not a header, not a body field.
 */

export const SID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** A real ticket is a few hundred characters. */
const MAX_TOKEN_CHARS = 2048;

const CLOCK_TOLERANCE_SECONDS = 5;

const BEARER = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i;

/**
 * @param {object} options
 * @param {string} options.secret
 * @param {string} [options.issuer]
 * @param {number} options.ttlSeconds
 * @param {() => number} [options.now]  milliseconds
 */
export function createTicketService({ secret, issuer = 'qatool', ttlSeconds, now = Date.now }) {
  const key = new TextEncoder().encode(secret);

  return {
    /**
     * @param {{ origin: string }} options  the allowed origin the visitor is calling from
     * @returns {Promise<{ ticket: string, sid: string, expiresAt: number }>} expiresAt in ms
     */
    async mint({ origin }) {
      const sid = randomBytes(16).toString('base64url');
      const issuedAt = Math.floor(now() / 1000);
      const expiresAt = issuedAt + ttlSeconds;

      const ticket = await new SignJWT({ sid })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuer(issuer)
        .setAudience(origin)
        .setIssuedAt(issuedAt)
        .setExpirationTime(expiresAt)
        .sign(key);

      return { ticket, sid, expiresAt: expiresAt * 1000 };
    },

    /**
     * @param {string} token
     * @param {{ origin: string }} options  the Origin of the request carrying it
     * @returns {Promise<{ sid: string, expiresAt: number }>}
     * @throws a jose error, or an Error with code ERR_TICKET_INVALID
     */
    async verify(token, { origin }) {
      const { payload } = await jwtVerify(token, key, {
        issuer,
        audience: origin,
        algorithms: ['HS256'],
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        requiredClaims: ['sid', 'iss', 'aud', 'iat', 'exp'],
        currentDate: new Date(now()),
      });

      if (typeof payload.sid !== 'string' || !SID_PATTERN.test(payload.sid)) {
        throw Object.assign(new Error('Ticket has no usable session id.'), {
          code: 'ERR_TICKET_INVALID',
        });
      }
      return { sid: payload.sid, expiresAt: payload.exp * 1000 };
    },
  };
}

const unauthenticated = () => new AppError('UNAUTHENTICATED', 'Authentication is required.', 401);

function logDenied(request, fields) {
  if (currentRun()) trace('request_denied', fields);
  else request.log.warn({ event: 'request_denied', ...fields });
}

/**
 * onRequest, demo mode: every route needs a valid ticket unless it is marked
 * `config.public`. Default deny, so an unknown path is a 401 too and the API cannot
 * be mapped by a caller without a ticket. Every refusal looks the same; the reason
 * is for the log.
 *
 * @param {object} options
 * @param {ReturnType<typeof createTicketService>} options.tickets
 * @param {(request: object) => { peer: string, client: string }} options.clientAddress
 * @param {{ touchSession: (sid: string) => void, inc: (name: string) => void }} [options.metrics]
 * @param {{ hit: (key: string) => { ok: true } | { ok: false, retryAfterMs: number } }} [options.limiter]
 *   a burst limit per `sid` for every route that does not carry its own (`config.ownLimit`):
 *   deterministic validation, export and the small read-only routes. The job routes have
 *   their own submit and poll limiters and are not counted here.
 */
export function createTicketHook({ tickets, clientAddress, metrics, limiter }) {
  return async function requireTicket(request) {
    if (request.method === 'OPTIONS') return;
    if (request.routeOptions?.config?.public === true) return;

    const refuse = (reason) => {
      metrics?.inc('auth_rejected');
      logDenied(request, {
        reason,
        status_code: 401,
        peer_ip: clientAddress(request).peer,
      });
      return unauthenticated();
    };

    const header = request.headers.authorization;
    if (typeof header !== 'string' || header === '') throw refuse('missing_ticket');
    const match = BEARER.exec(header.trim());
    if (!match || match[1].length > MAX_TOKEN_CHARS) throw refuse('invalid_ticket');

    // The origin hook has already insisted on an allowed Origin before this runs; a
    // missing one here is a wiring mistake, and refusing is the safe answer.
    const origin = request.headers.origin;
    if (typeof origin !== 'string' || origin === '') throw refuse('missing_origin');

    let verified;
    try {
      verified = await tickets.verify(match[1], { origin });
    } catch (cause) {
      throw refuse(classifyFailure(cause).reason);
    }

    const label = identityLabel(verified.sid);
    request.visitor = Object.freeze({ sid: verified.sid, label, expiresAt: verified.expiresAt });
    recordFacts({ identity: label });
    metrics?.touchSession(verified.sid);

    if (limiter && request.routeOptions?.config?.ownLimit !== true) {
      const allowance = limiter.hit(verified.sid);
      if (!allowance.ok) {
        metrics?.inc('rejected_rate_limited');
        throw Object.assign(
          new AppError('RATE_LIMITED', 'Too many requests. Wait a moment, then retry.', 429),
          { retryAfterSeconds: Math.max(1, Math.ceil(allowance.retryAfterMs / 1000)) }
        );
      }
    }
  };
}
