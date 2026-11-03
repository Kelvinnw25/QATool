import cors from '@fastify/cors';

import { createAccessHook, createAccessKeys } from './access.js';
import { createModelGate } from './gate.js';
import { createSecurityHeaders } from './headers.js';
import { createClientAddress } from './network.js';
import { corsOptions, createOriginHook } from './origin.js';
import { SlidingWindowLimiter } from './limiter.js';
import { createSessionService } from './session.js';
import { createTicketHook, createTicketService } from './ticket.js';
import { createTurnstileVerifier } from './turnstile.js';

/**
 * Wires the request-level controls into the app, in the one order that is right.
 *
 *   1. CORS         adds headers for an allowed origin and answers preflight, so a
 *                   refusal below still reaches the page as a readable error
 *   2. origin       exposed modes: refuses an unlisted Origin, and a request with none
 *   3. identity     owner mode: the Cloudflare Access JWT and the owner list
 *                   demo mode:  the visitor's ticket
 *                   Both default deny.
 *   4. rate         owner mode only: per-identity request rate
 *
 * All of it runs in `onRequest`, before the body is parsed, before a provider is
 * chosen and before a document is read: an unauthorised request costs one header
 * check and never reaches Apayee.
 *
 * The demo has no model gate and no request rate here. Its limits are per ticket and
 * per route, enforced where the routes are (server/jobs/), because a ticket's `sid`
 * is the only identity worth keying on there.
 *
 * `app.after()` is what puts steps 2 to 4 behind step 1. Hooks added with
 * `addHook` during setup run before the hooks of a plugin that loads later, which
 * would make the origin and identity checks answer first and strip the CORS headers
 * from their own refusals.
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {object} options
 * @param {ReturnType<import('./settings.js').loadSecuritySettings>} options.security
 * @param {object} [options.accessKeys]  jose key or resolver; defaults to Cloudflare's published keys
 * @param {() => number} [options.now]
 * @param {Function} [options.siteverify]  replaces the call to Cloudflare Turnstile (tests)
 * @param {ReturnType<import('../jobs/metrics.js').createJobMetrics>} [options.metrics]
 */
export function registerSecurity(app, { security, accessKeys, now, siteverify, metrics } = {}) {
  const demo = security.demoMode === true;
  const ownerMode = security.publicMode === true;
  const exposed = security.exposed ?? security.publicMode;

  const gate = createModelGate(security.gate, { now });
  const clientAddress = createClientAddress(security.trustedProxyPeers);
  const origins = new Set(security.allowedOrigins);

  app.decorate('security', security);
  app.decorate('modelGate', gate);
  app.decorateRequest('identity', null);
  app.decorateRequest('visitor', null);

  let tickets = null;
  if (demo) {
    const { ticket, turnstile, mintPerMinutePerIp } = security.demo;
    tickets = createTicketService({
      secret: ticket.secret,
      issuer: ticket.issuer,
      ttlSeconds: ticket.ttlSeconds,
      now,
    });
    const verifier = createTurnstileVerifier({
      secret: turnstile.secret,
      hostnames: turnstile.hostnames,
      action: turnstile.action,
      maxAgeMs: turnstile.maxAgeMs,
      timeoutMs: turnstile.timeoutMs,
      siteverify,
      now,
    });
    app.decorate(
      'sessions',
      createSessionService({ verifier, tickets, clientAddress, mintPerMinutePerIp, metrics, now })
    );
  }

  if (origins.size > 0) {
    app.register(
      cors,
      demo
        ? corsOptions(origins, {
            credentials: false,
            allowedHeaders: ['Content-Type', 'Authorization'],
          })
        : corsOptions(origins)
    );
  }

  app.after(() => {
    if (exposed) {
      app.addHook('onRequest', createOriginHook(origins, { requireOrigin: demo }));
    }

    if (ownerMode) {
      app.addHook(
        'onRequest',
        createAccessHook({
          access: security.access,
          keys: accessKeys ?? createAccessKeys(security.access.teamDomain),
          clientAddress,
        })
      );
    }

    if (demo) {
      // A generous burst limit per ticket for the routes that have no limiter of their own.
      const general = new SlidingWindowLimiter({
        limit: security.jobs.pollPerMinute,
        windowMs: 60_000,
        now,
      });
      app.addHook(
        'onRequest',
        createTicketHook({ tickets, clientAddress, metrics, limiter: general })
      );
    } else {
      app.addHook('onRequest', gate.rateHook);
    }

    app.addHook('onSend', createSecurityHeaders({ publicMode: exposed }));
  });
}
