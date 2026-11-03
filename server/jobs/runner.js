import { structureParsed } from '../extract/index.js';
import { generateFromRequirements } from '../generate/index.js';
import { requireCanonical } from '../pipeline/canonical-input.js';
import { createEmptyCanonical, mergeCanonical } from '../pipeline/merge.js';
import { buildValidationReport, deterministicChecks } from '../pipeline/validation.js';
import { recordFacts, setStage, summarise, trace, withRun } from '../lib/trace.js';
import { reviewSemantics } from '../semantic/index.js';
import { publicProvider } from './public-provider.js';
import { publicExtract, publicGenerate, publicValidate } from './public-result.js';

/**
 * One job's work: the browser's `runPipeline` (web/src/pipeline.js), done on the server.
 *
 *   extract   structuring call over the blocks parsed at submission   -> requirements, test points
 *   generate  test case generation                                     -> project outputs, test cases
 *   validate  deterministic checks, then the semantic review           -> the validation report
 *
 * A job starts at its `from` phase and runs every phase after it, folding each phase's
 * output into the project exactly as the browser does (pipeline/merge.js), so the
 * project a phase sees is the project the browser would have posted. The stages are the
 * same functions the routes call; nothing about their behaviour changes. Each phase's
 * output is stored the moment it finishes, so a workflow that fails in `generate` still
 * has its extraction to show and to resume from.
 *
 * Deterministic validation and export are not jobs. This is only the part that waits on
 * a model.
 *
 * The provider is chosen here and nowhere a visitor can reach: the catalog's `claude`
 * entry, acquired once for the whole job (it asks the gateway afresh whether it is
 * ready, and refuses rather than falling back to anything else). Nothing is retried.
 *
 * Each job runs inside its own trace run, so its log lines carry a run id and no
 * content, like a request's, and it ends with one summary line.
 */

/** The model every public job uses. A catalog id, fixed here; a visitor cannot name another. */
export const PUBLIC_PROVIDER_ID = 'claude';

/**
 * @param {object} options
 * @param {{ acquire: (id: string, options: object) => Promise<object> }} options.providers
 *   the provider catalog (llm/catalog.js), or a stand-in with the same method
 * @param {(capacity: object | null) => void} options.observeCapacity  the job manager's
 * @param {{ info?: Function, warn?: Function }} [options.logger]
 * @returns {(context: import('./manager.js').RunContext) => Promise<void>}
 */
export function createWorkflowRunner({ providers, observeCapacity, logger }) {
  return function runWorkflow(context) {
    return withRun({ logger, route: 'job' }, async (run) => {
      try {
        await runPhases(context, { providers, observeCapacity });
      } catch (error) {
        run.failure = { reason: error?.code ?? error?.name ?? 'UNKNOWN' };
        throw error;
      } finally {
        summarisePhase(run, logger);
      }
    });
  };
}

async function runPhases(context, { providers, observeCapacity }) {
  const { from, input, signal } = context;

  // Acquired once per job. It asks the gateway afresh, hands the capacity it reported to
  // the manager (so the worker ceiling follows the gateway), and throws if the gateway
  // cannot take work.
  setStage('PROVIDER');
  const provider = publicProvider(
    await providers.acquire(PUBLIC_PROVIDER_ID, { onCapacity: observeCapacity })
  );
  trace('provider_selected', { provider_choice: PUBLIC_PROVIDER_ID });
  recordFacts({ job_from: from });

  let working;
  let points;

  if (from === 'extract') {
    working = createEmptyCanonical(input.projectName);
    points = [];

    signal.throwIfAborted();
    context.beginPhase('extract');
    const extracted = await structureParsed(
      // The clock restarts here: the parse happened at submission, and the time since is
      // queue wait, not extraction.
      { ...input.parsed, startedAt: Date.now() },
      { provider, signal }
    );
    context.endPhase('extract', publicExtract(extracted));

    points = extracted.test_points ?? [];
    working = mergeCanonical(working, {
      documents: extracted.documents,
      requirements: extracted.requirements,
    });
  } else {
    working = requireCanonical(input.canonical);
    points = input.testPoints;
  }

  if (from === 'extract' || from === 'generate') {
    signal.throwIfAborted();
    context.beginPhase('generate');
    const generated = await generateFromRequirements(working, {
      testPoints: points,
      provider,
      signal,
    });
    context.endPhase('generate', publicGenerate(generated));

    working = mergeCanonical(working, {
      project: generated.project,
      test_cases: generated.test_cases,
    });
  }

  signal.throwIfAborted();
  context.beginPhase('validate');
  const checks = deterministicChecks(working);
  const semantic = await reviewSemantics(working, {
    useLlm: true,
    structurallyValid: checks.valid,
    testPoints: points,
    provider,
    signal,
  });
  context.endPhase('validate', publicValidate(buildValidationReport(working, checks, semantic)));
}

/** The one summary line a request gets from app.js, for a job. */
function summarisePhase(run, logger) {
  if (run.summarised) return;
  run.summarised = true;

  const degraded = !run.failure && run.facts.fallback_used === true;
  const status = run.failure ? 'FAILED' : degraded ? 'DEGRADED' : 'SUCCESS';

  logger?.info?.(
    summarise(run, {
      status,
      reason: run.failure?.reason ?? (degraded ? run.facts.fallback_reason : null),
      failSoft: run.failure ? false : degraded ? true : null,
      stage: degraded ? run.facts.fallback_stage : null,
    })
  );
}
