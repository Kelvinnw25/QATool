import { createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

import { AppError } from '../lib/errors.js';
import { currentRun, recordFacts, trace } from '../lib/trace.js';

/**
 * Cloudflare Access: the only way into the API in public mode.
 *
 * Access authenticates the owner at Cloudflare's edge and forwards a signed JWT
 * in `Cf-Access-Jwt-Assertion`. This file verifies that token itself, because a
 * request can reach the backend without passing the edge (a local process, a
 * misrouted tunnel) and a header that is merely present proves nothing.
 *
 * Verification is delegated to `jose`; nothing cryptographic is written here.
 * What this file decides is policy:
 *
 *  - RS256 only. `none`, HS256 and every other algorithm are refused, so a token
 *    cannot choose its own verification method.
 *  - Issuer is the team domain, audience is this application's tag, and the
 *    token must carry `exp` and `email`. A service token has no email and is
 *    refused: this API is for the owner, not for automation.
 *  - The email must be on the owner list. Access policy is the first gate, this
 *    list is the second, so a wider Access policy cannot widen API access.
 *  - Default deny: every request needs a token unless its route is explicitly
 *    marked public (`/healthz`). That includes unknown paths, so the API cannot
 *    be mapped by a caller who has no token, and a path trick cannot reach a
 *    route that this check did not name.
 *  - Fail closed. If the signing keys cannot be fetched the answer is 503, not
 *    "let it through".
 *
 * Every refusal to the caller is the same shape, whatever the reason; the reason
 * goes to the log only.
 */

export const ACCESS_HEADER = 'cf-access-jwt-assertion';

/** A real Access token is around 1 KB; anything past this is not one. */
const MAX_TOKEN_CHARS = 8192;

/** Small allowance for clock drift between Cloudflare and this PC. */
const CLOCK_TOLERANCE_SECONDS = 5;

/**
 * The key source for production: Cloudflare's published keys for the team,
 * cached in memory by jose and re-fetched when a token names an unknown key
 * (rotation), at most once per cooldown. No key is ever written to disk.
 */
export function createAccessKeys(teamDomain) {
  return createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`), {
    timeoutDuration: 5_000,
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000,
  });
}

/** A short, stable, non-reversible label for logs. Never the address itself. */
export function identityLabel(email) {
  return createHash('sha256').update(String(email).toLowerCase()).digest('hex').slice(0, 12);
}

/** What went wrong, as a log label, and whether the cause is on our side of the wire. */
export function classifyFailure(error) {
  switch (error?.code) {
    case 'ERR_JWT_EXPIRED':
      return { reason: 'expired', unavailable: false };
    case 'ERR_JWT_CLAIM_VALIDATION_FAILED': {
      const reason =
        error.claim === 'aud'
          ? 'wrong_audience'
          : error.claim === 'iss'
            ? 'wrong_issuer'
            : error.claim === 'nbf'
              ? 'not_yet_valid'
              : 'bad_claim';
      return { reason, unavailable: false };
    }
    case 'ERR_JOSE_ALG_NOT_ALLOWED':
      return { reason: 'bad_algorithm', unavailable: false };
    case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED':
      return { reason: 'bad_signature', unavailable: false };
    case 'ERR_JWKS_NO_MATCHING_KEY':
    case 'ERR_JWKS_MULTIPLE_MATCHING_KEYS':
      return { reason: 'unknown_key', unavailable: false };
    // The keys could not be fetched: not the caller's fault, and not a reason to open the door.
    case 'ERR_JWKS_TIMEOUT':
    case 'ERR_JOSE_GENERIC':
      return { reason: 'keys_unavailable', unavailable: true };
    default:
      return { reason: 'invalid_token', unavailable: false };
  }
}

const unauthenticated = () => new AppError('UNAUTHENTICATED', 'Authentication is required.', 401);

/** One place to record a refusal, with or without a run (non-API paths have none). */
function logDenied(request, fields) {
  if (currentRun()) {
    trace('request_denied', fields);
  } else {
    request.log.warn({ event: 'request_denied', ...fields });
  }
}

/**
 * @param {object} options
 * @param {{ teamDomain: string, audience: string, ownerEmails: string[] }} options.access
 * @param {Parameters<typeof jwtVerify>[1]} options.keys  a jose key or key resolver
 * @param {(request: object) => { peer: string, client: string }} options.clientAddress
 */
export function createAccessHook({ access, keys, clientAddress }) {
  const issuer = `https://${access.teamDomain}`;
  const owners = new Set(access.ownerEmails.map((email) => email.toLowerCase()));

  return async function requireOwner(request) {
    // A preflight carries no credentials by design. No route answers OPTIONS
    // with data, so skipping the check cannot expose any.
    if (request.method === 'OPTIONS') return;
    if (request.routeOptions?.config?.public === true) return;

    const where = clientAddress(request);
    const refuse = (reason, error) => {
      logDenied(request, {
        reason,
        status_code: error.statusCode,
        peer_ip: where.peer,
        client_ip: where.client,
      });
      return error;
    };

    const token = request.headers[ACCESS_HEADER];
    if (typeof token !== 'string' || token === '') throw refuse('missing_token', unauthenticated());
    if (token.length > MAX_TOKEN_CHARS) throw refuse('invalid_token', unauthenticated());

    let payload;
    try {
      ({ payload } = await jwtVerify(token, keys, {
        issuer,
        audience: access.audience,
        algorithms: ['RS256'],
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        requiredClaims: ['exp', 'email'],
      }));
    } catch (cause) {
      const { reason, unavailable } = classifyFailure(cause);
      throw refuse(
        reason,
        unavailable
          ? new AppError('AUTH_UNAVAILABLE', 'Authentication is temporarily unavailable.', 503)
          : unauthenticated()
      );
    }

    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
    if (!owners.has(email)) {
      throw refuse(
        'not_owner',
        new AppError('FORBIDDEN', 'This account may not use the API.', 403)
      );
    }

    const id = identityLabel(email);
    request.identity = Object.freeze({ owner: true, id });
    recordFacts({ identity: id });
    trace('request_authenticated', { identity: id, peer_ip: where.peer, client_ip: where.client });
  };
}
