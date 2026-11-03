import { AppError } from '../lib/errors.js';
import { currentRun, trace } from '../lib/trace.js';

/**
 * Which browser pages may talk to this API.
 *
 * CORS is a browser courtesy, not a lock: it tells a browser whether a page from
 * another origin may READ a reply. It does not stop a request from being sent
 * and it does not identify anyone. Authentication is access.js; this file only
 * keeps a page the owner did not choose from riding the owner's session.
 *
 * The allowlist is exact. An origin is allowed only if its text equals an entry
 * in ALLOWED_ORIGINS: no wildcard, no suffix match, no reflection of whatever
 * the request claims. `null` (sandboxed frames, local files) is never listed.
 *
 * Two pieces:
 *
 *  - corsOptions() configures @fastify/cors. It adds the response headers for an
 *    allowed origin, answers the preflight, and does nothing for anyone else.
 *  - createOriginHook() is the enforcement, in public mode: an Origin that is not
 *    listed is refused, and so is a state-changing request with no Origin at all.
 *    That second rule is the CSRF guard: a cross-site form post to the upload
 *    route is a "simple" request that needs no preflight, and only this check
 *    stops it from carrying the owner's cookie into the backend.
 *
 * Non-browser clients (curl, scripts) send no Origin and so cannot make POSTs in
 * public mode. That is intended: the live API is for the owner's browser.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Headers a cross-origin page must be allowed to read from the export download. */
export const EXPOSED_HEADERS = [
  'Content-Disposition',
  'X-QATOOL-Row-Count',
  'X-QATOOL-Export-Warnings',
  'Retry-After',
];

/**
 * @param {Set<string>} allowed
 * @param {{ credentials?: boolean, allowedHeaders?: string[] }} [options]  the demo sends a
 *   bearer ticket and no cookies, so it asks for no credentials and allows Authorization
 */
export function corsOptions(
  allowed,
  { credentials = true, allowedHeaders = ['Content-Type'] } = {}
) {
  return {
    origin: (origin, callback) => callback(null, typeof origin === 'string' && allowed.has(origin)),
    credentials,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders,
    exposedHeaders: EXPOSED_HEADERS,
    maxAge: 600,
    optionsSuccessStatus: 204,
  };
}

/**
 * @param {Set<string>} allowed
 * @param {{ requireOrigin?: boolean }} [options]  the demo API is only for a browser page on
 *   an allowed origin, so there a missing Origin is refused on every method, not just on
 *   state-changing ones. Routes marked `config.public` (the liveness probe) are exempt unless
 *   they also set `config.browser` (the session route is public but browser-only).
 */
export function createOriginHook(allowed, { requireOrigin = false } = {}) {
  const refuse = (request, reason, error) => {
    if (currentRun()) trace('request_denied', { reason, status_code: error.statusCode });
    else request.log.warn({ event: 'request_denied', reason, status_code: error.statusCode });
    return error;
  };

  return async function enforceOrigin(request) {
    // A preflight that the CORS plugin did not answer (an origin it does not
    // allow) reaches here; no route answers OPTIONS, so nothing is revealed.
    const origin = request.headers.origin;

    if (origin !== undefined) {
      if (typeof origin === 'string' && allowed.has(origin)) return;
      throw refuse(
        request,
        'origin_not_allowed',
        new AppError('ORIGIN_FORBIDDEN', 'This origin may not use the API.', 403)
      );
    }

    const config = request.routeOptions?.config;
    const exempt = requireOrigin && config?.public === true && config?.browser !== true;
    const mustHaveOrigin = requireOrigin
      ? request.method !== 'OPTIONS'
      : !SAFE_METHODS.has(request.method);

    if (mustHaveOrigin && !exempt) {
      throw refuse(
        request,
        'origin_missing',
        new AppError('ORIGIN_FORBIDDEN', 'This origin may not use the API.', 403)
      );
    }
  };
}
