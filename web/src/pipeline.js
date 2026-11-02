import { mergeCanonical } from './state/merge.js';

/** The phases, in the order they run. */
export const PHASE_KEYS = ['extract', 'generate', 'validate'];

/**
 * Runs the pipeline from `from` onward, threading the project through the
 * phases explicitly.
 *
 * Explicitly, because React state cannot carry it between phases. A phase's
 * output reaches the provider as a state update, and an update made in an async
 * continuation is batched: it is not rendered - and so not visible through
 * anything read during a render - until the current task ends. The next phase
 * starts inside that same task. So each phase used to post the project as it
 * stood BEFORE the phase that had just finished: generation received no
 * requirements and was refused with NO_REQUIREMENTS, and once a retry got
 * generation through, validation received no test cases and reported every
 * requirement as uncovered while the page showed the test cases citing them.
 * Measured in a real browser against the real component, not inferred.
 *
 * The working copy is folded with the same mergeCanonical the provider uses, so
 * the project posted to each phase and the project shown afterwards agree by
 * construction rather than by render timing.
 *
 * `provider` is the run's model, passed unchanged to all three calls - extract,
 * generate and validate - so a run cannot end up split across two models. It is
 * a catalog id, or null to leave the choice to the server. A retry passes the
 * same value again.
 *
 * `isCurrent` says whether anyone still wants this run's results. It is asked
 * before each phase and after each call returns; once it says no, the run stops
 * quietly - no callback fires and no further call is made - so a run that was
 * replaced while a response was in flight cannot write into the new one.
 *
 * Callbacks report progress and hand each phase's output to the caller; they
 * run inside the phase, so one that throws fails that phase like any other
 * error. Returns whether every phase completed, and whether the run was
 * superseded.
 */
export async function runPipeline({
  from = 'extract',
  canonical,
  files,
  testPoints = [],
  provider = null,
  isCurrent = () => true,
  api,
  on = {},
}) {
  const start = PHASE_KEYS.indexOf(from);
  if (start === -1) throw new Error(`Unknown pipeline phase: ${from}`);

  let working = canonical;
  let points = testPoints;
  const superseded = () => ({ completed: false, superseded: true, canonical: working });

  for (const phase of PHASE_KEYS.slice(start)) {
    if (!isCurrent()) return superseded();
    on.started?.(phase);

    try {
      if (phase === 'extract') {
        const result = await api.extract(files, { provider });
        if (!isCurrent()) return superseded();
        // Guidance from Gemini #1. Held beside the canonical project, not
        // inside it: the canonical schema is strict and this is advice about
        // what to test, not a fact about the project.
        points = result.test_points ?? [];
        const partial = { documents: result.documents, requirements: result.requirements };
        working = mergeCanonical(working, partial);
        on.extracted?.(result, partial);
      } else if (phase === 'generate') {
        const result = await api.generate(working, points, { provider });
        if (!isCurrent()) return superseded();
        // Only the canonical fields are merged. warnings and metadata are about
        // the run, not the project, and canonicalProjectSchema is strict -
        // merging them in would fail the very next /api/validate.
        const partial = { project: result.project, test_cases: result.test_cases };
        working = mergeCanonical(working, partial);
        on.generated?.(result, partial);
      } else {
        // A failed semantic review comes back as a result, not an error: the
        // Results page reports it and can retry the review alone.
        //
        // Awaited on its own line, never inside the callback's argument list:
        // `on.validated?.(await api.validate(...))` skips the whole call,
        // arguments included, when no one is listening - validation silently
        // never ran and the phase still reported itself complete.
        const validation = await api.validate(working, {
          semantic: true,
          testPoints: points,
          provider,
        });
        if (!isCurrent()) return superseded();
        on.validated?.(validation);
      }
    } catch (cause) {
      if (!isCurrent()) return superseded();
      on.failed?.(phase, cause);
      return { completed: false, superseded: false, canonical: working };
    }

    on.completed?.(phase);
  }

  return { completed: true, superseded: false, canonical: working };
}
