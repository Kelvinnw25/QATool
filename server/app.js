import fs from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';

import { config, isProduction, redactSecrets } from './config.js';
import { AppError } from './lib/errors.js';
import { beginRun, currentRun, summarise, trace } from './lib/trace.js';

import llmRoutes from './routes/llm.js';
import metaRoutes from './routes/meta.js';
import pipelineRoutes from './routes/pipeline.js';

/**
 * Builds the Fastify instance.
 *
 * The server holds no state of any kind: every endpoint is a pure function of
 * its request body. Canonical project data lives in the browser and is passed
 * in on each call, so there is nothing to inject here and nothing to reset
 * between tests.
 *
 * @param {{ logger?: boolean | object }} [options]
 */
export function buildApp({ logger = false } = {}) {
  const app = Fastify({
    logger,
    bodyLimit: config.maxBodyBytes,
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
    if (run) {
      run.failure = { reason: error.code ?? error.name ?? 'UNKNOWN' };
      trace('request_failed', {
        error_class: error.constructor?.name ?? 'Error',
        error_code: error.code ?? null,
        error_message: error.message,
        status_code: error.statusCode ?? 500,
        fail_soft: false,
      });
    }

    if (error instanceof AppError) {
      // run_id is diagnostic metadata only: the code, message and details are
      // unchanged, so nothing reading this response can break on it.
      const body = error.toJSON();
      return reply.code(error.statusCode).send({
        error: run ? { ...body, run_id: run.id } : body,
      });
    }

    // Fastify's own client-side errors (bad JSON, unknown route, oversized
    // body) are safe to relay; anything else is ours and might carry internals
    // or document content, so it is logged and replaced (PRD 20).
    if (error.statusCode && error.statusCode < 500) {
      return reply.code(error.statusCode).send({
        error: {
          code: error.code ?? 'BAD_REQUEST',
          message: error.message,
          ...(run ? { run_id: run.id } : {}),
        },
      });
    }

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
    // are client routes and must return the shell, not a 404.
    if (isProduction && fs.existsSync(config.webDistDir)) {
      return reply.sendFile('index.html');
    }

    return reply.code(404).send({
      error: { code: 'NOT_FOUND', message: 'Not found. In development the UI is served by Vite.' },
    });
  });

  // Uploads are held in memory and read with toBuffer(). saveRequestFiles() is
  // never called, so nothing is written to a temporary directory.
  app.register(fastifyMultipart, {
    limits: {
      fileSize: config.maxBodyBytes,
      files: 20,
      fields: 10,
    },
  });

  app.register(metaRoutes);
  app.register(llmRoutes);
  app.register(pipelineRoutes);

  if (isProduction && fs.existsSync(config.webDistDir)) {
    app.register(fastifyStatic, { root: config.webDistDir });
  }

  return app;
}
