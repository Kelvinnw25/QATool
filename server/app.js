import fs from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';

import { config, isProduction, redactSecrets } from './config.js';
import { beginRun, currentRun, summarise, trace } from './lib/trace.js';

import { registerJobs } from './jobs/index.js';
import { createJobMetrics } from './jobs/metrics.js';
import { providerAvailability } from './llm/catalog.js';
import llmRoutes from './routes/llm.js';
import metaRoutes from './routes/meta.js';
import pipelineRoutes from './routes/pipeline.js';
import sessionRoutes from './routes/session.js';
import { registerSecurity } from './security/index.js';
import { presentError } from './security/public-errors.js';
import { assertSecuritySettings } from './security/settings.js';

/**
 * Builds the Fastify instance.
 *
 * The server holds no state of any kind: every endpoint is a pure function of
 * its request body. Canonical project data lives in the browser and is passed
 * in on each call, so there is nothing to inject here and nothing to reset
 * between tests.
 *
 * The one exception is the model gate (server/security/gate.js): request counters
 * and a concurrency ceiling held in this instance's memory, never on disk, reset
 * by a restart, and switched off unless limits are configured.
 *
 * @param {object} [options]
 * @param {boolean | object} [options.logger]
 * @param {object} [options.security]    defaults to config.security; tests pass their own
 * @param {object} [options.accessKeys]  jose key or key resolver for the Access JWT;
 *                                       defaults to Cloudflare's published keys
 * @param {() => number} [options.now]   clock for the gate; tests pass their own
 * @param {Function} [options.siteverify] replaces the call to Cloudflare Turnstile (demo mode; tests)
 * @param {{ acquire: Function, capacity: Function }} [options.providers] the provider catalog the
 *                                       demo's jobs use; tests pass a stand-in
 * @throws {import('./security/settings.js').SecurityConfigError} when public mode is
 *         switched on without the configuration that makes it safe
 */
export function buildApp({
  logger = false,
  security = config.security,
  accessKeys,
  now,
  siteverify,
  providers = providerAvailability,
} = {}) {
  assertSecuritySettings(security, config.llm);
  const { limits } = security;
  const demo = security.demoMode === true;
  // Owner mode or demo: errors are scrubbed, no frontend is served from this process.
  const exposed = security.exposed ?? security.publicMode;
  const metrics = createJobMetrics();

  const app = Fastify({
    logger,
    bodyLimit: Math.min(config.maxBodyBytes, limits.jsonBodyMaxBytes),
    // Node's own default stays unless a limit is set (public mode sets one).
    ...(limits.requestTimeoutMs > 0 ? { requestTimeout: limits.requestTimeoutMs } : {}),
  });

  /**
   * One run per API request, started before the handler.
   *
   * enterWith rather than run(): a hook cannot wrap the handler that follows
   * it, but it can attach the store to the async context they share. Only
   * /api/ paths get a run - static asset requests are not pipeline work and
   * would bury the interesting lines.
   */
  app.addHook('onRequest', (request, reply, done) => {
    if (request.url.startsWith('/api/')) {
      beginRun({ logger: request.log, route: request.url });
      trace('request_received', { method: request.method, route: request.url });
    }
    done();
  });

  /**
   * The one summary per run, emitted here because onResponse is the only hook
   * that runs for both outcomes - a handler that returned and a handler that
   * threw. The error handler records why; this decides the verdict.
   */
  app.addHook('onResponse', (request, reply, done) => {
    const run = currentRun();
    if (run && !run.summarised) {
      run.summarised = true;

      const statusCode = reply.statusCode;
      trace('request_completed', {
        status_code: statusCode,
        duration_ms: Date.now() - run.startedAt,
      });

      // DEGRADED is not a failure: the run produced its output, but a stage
      // fell back and the result is worth less than a clean one. Saying so in
      // the summary is the whole point - it is invisible in the response.
      const status = run.failure
        ? 'FAILED'
        : run.facts.fallback_used === true
          ? 'DEGRADED'
          : 'SUCCESS';

      request.log.info(
        summarise(run, {
          status,
          reason: run.failure?.reason ?? (status === 'DEGRADED' ? run.facts.fallback_reason : null),
          failSoft: run.failure ? false : status === 'DEGRADED' ? true : null,
          // Where it degraded, not where it finished.
          stage: status === 'DEGRADED' ? run.facts.fallback_stage : null,
        })
      );
    }
    done();
  });

  app.setErrorHandler((error, request, reply) => {
    const run = currentRun();

    // What the caller will be told. In public mode this is text written for a
    // network, not the error's own message, and the log records the same text.
    const shown = presentError(error, { publicMode: exposed });

    if (run) {
      run.failure = { reason: error.code ?? error.name ?? 'UNKNOWN' };
      trace('request_failed', {
        error_class: error.constructor?.name ?? 'Error',
        error_code: error.code ?? null,
        error_message: shown.expected ? shown.logMessage : error.message,
        status_code: error.statusCode ?? 500,
        fail_soft: false,
      });
    }

    // A refusal for rate, budget or capacity says when to come back.
    if (error.retryAfterSeconds) reply.header('Retry-After', String(error.retryAfterSeconds));

    // AppErrors, and Fastify's own client-side errors (bad JSON, unknown route,
    // oversized body), are relayed. run_id is diagnostic metadata only: the code,
    // message and details are unchanged, so nothing reading this can break on it.
    if (shown.expected) {
      return reply.code(shown.status).send({
        error: run ? { ...shown.body, run_id: run.id } : shown.body,
      });
    }

    // Anything else is ours and might carry internals or document content, so it
    // is logged and replaced (PRD 20).

    // Redacted before it reaches the log: an unexpected error from the LLM
    // transport could carry the request, and the request carries the key.
    error.message = redactSecrets(error.message);
    request.log.error({ err: error, run_id: run?.id ?? null }, 'Unhandled error');
    return reply.code(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An internal error occurred. Check the server log for details.',
        ...(run ? { run_id: run.id } : {}),
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: `No route for ${request.method} ${request.url}.` },
      });
    }

    // In production the frontend is a single-page app: unknown non-API paths
    // are client routes and must return the shell, not a 404. Public mode serves
    // no frontend at all: it is hosted elsewhere and this process is only an API.
    if (!exposed && isProduction && fs.existsSync(config.webDistDir)) {
      return reply.sendFile('index.html');
    }

    return reply.code(404).send({
      error: { code: 'NOT_FOUND', message: 'Not found. In development the UI is served by Vite.' },
    });
  });

  // After the run-starting hook above, never before: hooks run in the order they
  // were added, and the security checks must run inside a request that already has
  // its run (id, timing, summary line). Registered before the routes for the same
  // reason - a hook only covers routes added after it.
  registerSecurity(app, { security, accessKeys, now, siteverify, metrics });

  // Uploads are held in memory and read chunk by chunk (security/uploads.js), which
  // enforces the file count, the per-file size and the TOTAL size while streaming.
  // saveRequestFiles() is never called, so nothing is written to a temporary
  // directory. The limits here are the plugin's own copy of the first two.
  app.register(fastifyMultipart, {
    limits: {
      fileSize: limits.uploadMaxFileBytes,
      // One more than the real limit, on purpose. At exactly the limit the plugin
      // destroys the extra file's stream and the reader sees an opaque "premature
      // close"; with one to spare, uploads.js sees the extra file itself and
      // answers TOO_MANY_FILES. The plugin's limit remains a backstop.
      files: limits.uploadMaxFiles + 1,
      parts: limits.uploadMaxFiles + 11,
      fields: 10,
      fieldSize: 64 * 1024,
    },
  });

  app.register(metaRoutes);
  // The demo's model is fixed on the server. A provider list, with the gateway's state in it,
  // is not something a visitor is shown.
  if (!demo) app.register(llmRoutes);
  app.register(pipelineRoutes);

  if (demo) {
    app.register(sessionRoutes);
    registerJobs(app, { security, llm: config.llm, providers, metrics, now });
  }

  if (!exposed && isProduction && fs.existsSync(config.webDistDir)) {
    app.register(fastifyStatic, { root: config.webDistDir });
  }

  return app;
}
