import { SlidingWindowLimiter } from '../security/limiter.js';
import { createProviderBreaker } from './breaker.js';
import { serviceUnavailable } from './errors.js';
import { JobManager } from './manager.js';
import { createJobMetrics } from './metrics.js';
import { createWorkflowRunner, PUBLIC_PROVIDER_ID } from './runner.js';
import jobRoutes from './routes.js';

/**
 * Builds the job platform for the public demo and registers its routes.
 *
 * Everything the platform needs is created here, in one place, and handed to the
 * routes as `app.jobPlatform`:
 *
 *   manager   the bounded in-memory job system (manager.js)
 *   metrics   the in-memory operations numbers; internal, no route serves them
 *   limiters  burst protection per ticket: one bucket for submissions, a separate and
 *             more generous one for polling
 *   checkProvider  whether the gateway can take work at all (cached; never a model call)
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {object} options
 * @param {object} options.security   config.security
 * @param {{ timeoutMs: number }} options.llm  config.llm: the per-call timeout sets the job deadline
 * @param {{ acquire: Function, capacity: Function }} options.providers  the provider catalog,
 *   or a stand-in with the same two methods
 * @param {ReturnType<typeof createJobMetrics>} options.metrics
 * @param {() => number} [options.now]
 */
export function registerJobs(app, { security, llm, providers, metrics, now = Date.now }) {
  const jobSettings = security.jobs;

  // 3 model calls, each allowed its own timeout, plus two minutes for parsing's remainder,
  // folding, validation and slack. Measured from the moment a worker picks the job up.
  const deadlineMs =
    jobSettings.deadlineMs > 0 ? jobSettings.deadlineMs : 3 * llm.timeoutMs + 120_000;

  const breaker = createProviderBreaker({ cooldownMs: jobSettings.breakerCooldownMs, now });

  /** @type {JobManager} */
  let manager;
  const run = createWorkflowRunner({
    providers,
    observeCapacity: (capacity) => manager.observeCapacity(capacity),
    logger: app.log,
  });
  manager = new JobManager({
    settings: { ...jobSettings, deadlineMs },
    run,
    breaker,
    metrics,
    now,
    logger: app.log,
  });
  manager.start();

  const limiters = {
    submit: new SlidingWindowLimiter({ limit: jobSettings.submitPerMinute, windowMs: 60_000, now }),
    poll: new SlidingWindowLimiter({ limit: jobSettings.pollPerMinute, windowMs: 60_000, now }),
  };

  /**
   * Can the gateway take a job at all? Read from the same short-lived health answer the
   * rest of the system uses, so a burst of submissions does not become a burst of health
   * checks. Also tells the manager what the gateway can run at once.
   */
  async function checkProvider() {
    const { status, capacity } = await providers.capacity(PUBLIC_PROVIDER_ID);
    manager.observeCapacity(capacity);
    if (!status.available) {
      metrics.inc('rejected_unavailable');
      throw serviceUnavailable();
    }
  }

  app.decorate(
    'jobPlatform',
    Object.freeze({ manager, metrics, limiters, checkProvider, breaker })
  );

  // Before the server stops listening: admission stops and running work is aborted, which
  // closes the gateway connections and so cancels the calls in the gateway too.
  app.addHook('preClose', async () => {
    await manager.shutdown();
  });
  app.addHook('onClose', async () => {
    await manager.shutdown();
  });

  app.register(jobRoutes);
}
