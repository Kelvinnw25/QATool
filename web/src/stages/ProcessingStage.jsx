import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { JobProgress } from '../components/JobProgress.jsx';
import { describeFailure } from '../jobs/failure.js';
import { createJobHandle, runJobPipeline, sharedBoot } from '../jobs/run.js';
import { PHASE_KEYS, runPipeline } from '../pipeline.js';
import { useSession } from '../session/SessionProvider.jsx';
import { useConfig } from '../state/appConfig.js';
import { useCanonical } from '../state/canonical.jsx';

/**
 * Runs the pipeline as one batch: extract, then generate, then validate.
 *
 * Each phase's output is merged into working memory as it completes, so a
 * failure in a later phase never costs the earlier work. Retry resumes at the
 * phase that failed - the documents are not re-uploaded and a successful
 * extraction is never repeated.
 */
/**
 * What to tell the user when a specific failure happens. The generic line is
 * true for all of them; these say what is worth doing differently, because a
 * missing API key is not something a retry will fix.
 */
const RETRY_ADVICE = {
  PROVIDER_UNAVAILABLE:
    'The model chosen for this run is not available right now. Nothing was sent to it, and QATOOL will not switch to another model on its own. Retry once it is back, or go back and start a new run with a different model.',
  UNKNOWN_PROVIDER:
    'The server does not recognise the model chosen for this run. Go back and start a new run.',
  LLM_NOT_CONFIGURED:
    'The server has no usable LLM configuration, so retrying will not help until it is fixed. Your extracted requirements are still held in memory.',
  LLM_AUTH_FAILED:
    'The provider rejected the server’s API key. Extracted requirements are kept, so generation can be retried once the key is corrected.',
  LLM_RATE_LIMITED:
    'The provider is rate limiting. Wait a moment, then retry — nothing needs re-uploading or re-extracting.',
  LLM_UNAVAILABLE:
    'The provider is temporarily unavailable. Wait a minute or two, then retry from this step — your extracted requirements are kept.',
  LLM_TIMEOUT:
    'The provider did not answer in time. Retry from this step; documents are not re-uploaded.',
  GENERATION_INVALID:
    'The model returned content that failed validation, so it was rejected rather than repaired. Retrying asks it again from the same requirements.',
  LLM_MALFORMED_OUTPUT:
    'The model returned JSON in the wrong shape, so nothing was accepted. Retrying asks it again from the same requirements.',
  LLM_TRUNCATED:
    'The reply was cut off before it finished. Retry, or reduce the number of requirements.',
  GENERATION_EMPTY:
    'No usable test cases came back. Check the extraction report above — the requirements may be too thin to test from.',
};

const PHASE_LABELS = {
  extract: 'Extracting requirements from documents',
  generate: 'Generating test cases and project outputs',
  validate: 'Validating structure, coverage and meaning',
};

// Order comes from the runner, labels from here, so the list shown and the
// phases run cannot disagree.
const PHASES = PHASE_KEYS.map((key) => ({ key, label: PHASE_LABELS[key] }));

export function ProcessingStage({ files, onAdvance, onBack }) {
  const { canonical, run: current, actions } = useCanonical();
  const { demo } = useConfig();
  const session = useSession();

  // Frozen when the run began (see state/run.js). Read once here and used for
  // every phase and every retry; there is no setter to change it from this page.
  const runId = current?.id ?? 0;
  const provider = current?.provider ?? null;
  const modelLabel = current?.label ?? 'Server default';
  const [completed, setCompleted] = useState([]);
  const [active, setActive] = useState(null);
  const [failure, setFailure] = useState(null);
  const [extraction, setExtraction] = useState(null);

  // Public demo only. The backend job as last reported, what the page is doing before there is one,
  // and the things a visitor should be told about while it runs.
  const [job, setJob] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [waiting, setWaiting] = useState(null);
  const [leaseGapMs, setLeaseGapMs] = useState(null);
  const [trouble, setTrouble] = useState(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [notice, setNotice] = useState(null);
  const handleRef = useRef(null);
  const jobRef = useRef(null);
  const startedRef = useRef(false);

  // Where a run STARTS: the project as last rendered. A retry is a click, so by
  // then everything earlier phases merged has rendered. Never read mid-run - a
  // phase's merge is not rendered until the run's task ends, which is why
  // runPipeline carries the project between phases itself.
  const canonicalRef = useRef(canonical);
  canonicalRef.current = canonical;

  // Survives the phase loop without re-rendering it; discarded with the page.
  const testPointsRef = useRef([]);

  /**
   * The public demo's run: one backend job from `fromPhase` onward, followed until it ends. The
   * same callbacks as the local run hand each finished phase to the same state; what differs is
   * that the server, not this page, runs the phases and the page watches.
   */
  const runJob = useCallback(
    async (fromPhase, attach = null) => {
      setFailure(null);
      setCancelled(false);
      setCancelling(false);
      setWaiting(null);
      setTrouble(null);
      setLeaseGapMs(null);
      if (!attach) {
        setJob(null);
        setNotice(null);
      }
      setSubmitting(!attach);
      actions.setRunActive(runId, true);

      const startIndex = PHASES.findIndex((phase) => phase.key === fromPhase);
      setCompleted(PHASES.slice(0, startIndex).map((phase) => phase.key));

      const handle = createJobHandle(api);
      handleRef.current = handle;
      const working = canonicalRef.current;

      const outcome = await runJobPipeline({
        from: fromPhase,
        canonical: working,
        files,
        projectName: working.project.project_name,
        testPoints: testPointsRef.current,
        isCurrent: () => actions.isCurrentRun(runId),
        api,
        handle,
        boot: sharedBoot,
        attach,
        on: {
          waiting: (info) => setWaiting(info),
          accepted: (accepted, info) => {
            setSubmitting(false);
            setWaiting(null);
            setJob(accepted);
            jobRef.current = accepted;
            if (info.recovered && !attach) setNotice('reconnected');
            else if (info.restarted) setNotice('restarted');
          },
          progress: (view) => {
            setJob(view);
            jobRef.current = view;
            setTrouble(null);
          },
          pollTrouble: (info) => setTrouble(info),
          leaseGap: (ms) => setLeaseGapMs(ms),
          extracted: (result, partial) => {
            setExtraction(result);
            testPointsRef.current = result.test_points ?? [];
            actions.mergePhase(partial);
          },
          generated: (result, partial) => {
            actions.mergePhase(partial);
            actions.setGeneration({ warnings: result.warnings, metadata: result.metadata });
          },
          validated: (validation) => actions.setValidation(validation),
          completed: (phase) => setCompleted((previous) => [...previous, phase]),
          cancelled: () => setCancelled(true),
          failed: (phase, cause) => {
            setSubmitting(false);
            setWaiting(null);
            const described = describeFailure(cause);
            setFailure({
              phase,
              message: described.message,
              code: cause.code,
              details: Array.isArray(cause.details) ? cause.details : [],
              described,
              ambiguous: cause.ambiguous === true,
            });
          },
        },
      });

      if (outcome.superseded) return;

      actions.setRunActive(runId, false);
      setSubmitting(false);
      if (outcome.completed) onAdvance('results');
    },
    [actions, files, onAdvance, runId]
  );

  async function cancelJob() {
    setCancelling(true);
    try {
      const latest = await handleRef.current?.cancel();
      if (latest) setJob(latest);
    } catch (cause) {
      setCancelling(false);
      setFailure({
        phase: failure?.phase ?? 'extract',
        message: describeFailure(cause).message,
        code: cause.code,
        details: [],
        described: describeFailure(cause),
      });
    }
  }

  const run = useCallback(
    async (fromPhase = 'extract') => {
      if (demo) return runJob(fromPhase);
      setFailure(null);
      actions.setRunActive(runId, true);

      const startIndex = PHASES.findIndex((phase) => phase.key === fromPhase);
      setCompleted(PHASES.slice(0, startIndex).map((phase) => phase.key));

      const { completed: finished, superseded } = await runPipeline({
        from: fromPhase,
        canonical: canonicalRef.current,
        files,
        testPoints: testPointsRef.current,
        provider,
        isCurrent: () => actions.isCurrentRun(runId),
        api,
        on: {
          started: (phase) => setActive(phase),
          extracted: (result, partial) => {
            setExtraction(result);
            testPointsRef.current = result.test_points ?? [];
            actions.mergePhase(partial);
          },
          generated: (result, partial) => {
            actions.mergePhase(partial);
            actions.setGeneration({ warnings: result.warnings, metadata: result.metadata });
          },
          validated: (validation) => actions.setValidation(validation),
          completed: (phase) => setCompleted((current) => [...current, phase]),
          failed: (phase, cause) => {
            setActive(null);
            setFailure({
              phase,
              message: cause.message,
              code: cause.code,
              details: Array.isArray(cause.details) ? cause.details : [],
            });
          },
        },
      });

      // Replaced while it was running: whoever replaced it owns this page now.
      if (superseded) return;

      actions.setRunActive(runId, false);
      if (!finished) return;

      setActive(null);
      onAdvance('results');
    },
    [actions, demo, files, onAdvance, provider, runId, runJob]
  );

  useEffect(() => {
    // Under StrictMode (development) this effect runs twice; one backend job per page is enough, and
    // a second submission would only be told the first is still active.
    if (demo) {
      if (startedRef.current) return;
      startedRef.current = true;
    }
    run('extract');
    // Runs once on entry; retry is driven by the button below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const extractionDone = completed.includes('extract');

  return (
    <>
      <div className="card">
        <h2>Processing</h2>
        {!demo && (
          <p className="muted" style={{ marginTop: -4 }}>
            Model for this run: <span className="badge">{modelLabel}</span> &mdash; fixed for every
            step and every retry.
          </p>
        )}
        <ul className="phases">
          {PHASES.map((phase) => {
            const state = demo
              ? demoPhaseState(
                  job?.phases?.[phase.key],
                  completed.includes(phase.key),
                  failure,
                  phase.key
                )
              : completed.includes(phase.key)
                ? 'done'
                : active === phase.key
                  ? 'active'
                  : failure?.phase === phase.key
                    ? 'failed'
                    : 'waiting';

            return (
              <li key={phase.key} className={`phase ${state}`}>
                <span className="phase-mark">
                  {state === 'done' ? '✓' : state === 'failed' ? '✗' : '·'}
                </span>
                {phase.label}
                {state === 'active' && <span className="muted"> &mdash; working...</span>}
              </li>
            );
          })}
        </ul>

        {demo && !failure && !cancelled && (
          <JobProgress
            job={job}
            submitting={submitting}
            waiting={waiting}
            trouble={trouble}
            leaseGapMs={leaseGapMs}
            cancelling={cancelling}
            onCancel={cancelJob}
            phaseLabels={PHASE_LABELS}
          />
        )}

        {demo && notice === 'reconnected' && (
          <div className="notice">
            You already had a job for this step in progress, so this page reconnected to it instead
            of starting another.
          </div>
        )}
        {demo && notice === 'restarted' && (
          <div className="notice">
            The demo server restarted since your last job, so anything it was holding was lost. This
            run started fresh.
          </div>
        )}
      </div>

      {demo && cancelled && (
        <div className="card">
          <div className="notice">
            <strong>The job was cancelled.</strong> Nothing more will run.
            {extractionDone && ' What was already extracted is kept.'}
          </div>
          <div className="row">
            {extractionDone && (
              <button type="button" onClick={() => onAdvance('results')}>
                View extracted requirements &rarr;
              </button>
            )}
            <button type="button" className="secondary" onClick={onBack}>
              Back to upload
            </button>
          </div>
        </div>
      )}

      {extractionDone && extraction && <ExtractionReport extraction={extraction} />}

      {failure && (
        <div className="card">
          <div className="notice error">
            <strong>{failure.message}</strong>
            {failure.details.length > 0 && (
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {failure.details.map((detail, index) => (
                  <li key={index}>
                    {detail.filename ? `${detail.filename}: ` : ''}
                    {detail.message ??
                      (detail.extracted_char_count !== undefined
                        ? `${detail.extracted_char_count} characters extracted`
                        : JSON.stringify(detail))}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {!demo && (
            <p className="muted">
              {RETRY_ADVICE[failure.code] ??
                'Everything completed before this step is still held in memory. Retrying resumes from here — documents are not re-uploaded and earlier work is not repeated.'}
            </p>
          )}
          {demo && (
            <p className="muted">
              Everything finished before this step is still in this page. Retrying resumes from here
              {failure.phase === 'extract' ? ' and sends your documents again' : ''}.
              {failure.ambiguous &&
                ' The connection dropped while sending, so it is not known whether the server received it. Nothing was sent twice: pressing the button checks first, and if the server already has your job this page reconnects to it instead of starting another.'}
            </p>
          )}

          <div className="row">
            {demo ? (
              <DemoRetry
                failure={failure}
                sessionReady={session.ready}
                onRetry={() => run(failure.phase)}
                onReconnect={() => runJob(failure.phase, jobRef.current)}
              />
            ) : (
              <button type="button" onClick={() => run(failure.phase)}>
                Retry from this step
              </button>
            )}
            {extractionDone && (
              <button type="button" onClick={() => onAdvance('results')}>
                View extracted requirements &rarr;
              </button>
            )}
            <button type="button" className="secondary" onClick={onBack}>
              Back to upload
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/** Per-document status, text metrics and extraction warnings. */
function ExtractionReport({ extraction }) {
  const { documents, metrics, warnings } = extraction;

  return (
    <>
      <div className="card">
        <h2>Documents</h2>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Filename</th>
              <th>Type</th>
              <th>Pages</th>
              <th>Text</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {documents.map((document) => (
              <tr key={document.document_id}>
                <td>
                  <span className="badge mono">{document.document_id}</span>
                </td>
                <td>{document.filename}</td>
                <td className="muted">{document.document_type}</td>
                <td className="muted">
                  {/* DOCX and XLSX have no pages; that is a fact, not a gap. */}
                  {document.page_count ?? <span title="Not applicable to this format">n/a</span>}
                </td>
                <td className="muted">
                  {document.extracted_char_count === null
                    ? '—'
                    : `${document.extracted_char_count.toLocaleString()} chars`}
                </td>
                <td>
                  <span
                    className={`badge ${document.status === 'Extracted' ? 'ok' : document.status === 'Failed' ? 'warn' : ''}`}
                  >
                    {document.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <p style={{ marginBottom: 0, marginTop: 12 }}>
          <span className="badge ok">{metrics.requirement_count} requirements extracted</span>{' '}
          {metrics.failed_document_count > 0 && (
            <span className="badge warn">{metrics.failed_document_count} document(s) failed</span>
          )}
        </p>
      </div>

      {warnings.length > 0 && (
        <div className="card">
          <h2>Extraction warnings ({warnings.length})</h2>
          <ul className="issues">
            {warnings.map((warning, index) => (
              <li key={index}>
                <span className="mono">{warning.code}</span> &mdash; {warning.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/** A phase's row state, from what the backend reported (or, before it did, what this page knows). */
function demoPhaseState(reported, finished, failure, key) {
  if (reported === 'done' || reported === 'skipped') return 'done';
  if (reported === 'running') return 'active';
  if (reported === 'failed' || reported === 'cancelled') return 'failed';
  if (finished) return 'done';
  return failure?.phase === key ? 'failed' : 'waiting';
}

/**
 * The retry control for a failed demo step. It waits out a Retry-After the server gave, is not
 * offered when a retry cannot help (a rejected file, a blocked site), and for a lost connection
 * offers to follow the same job rather than start another.
 */
function DemoRetry({ failure, sessionReady, onRetry, onReconnect }) {
  const { retry, retryAfterSeconds, reconnect, kind } = failure.described;
  const [readyAt] = useState(() => Date.now() + (retryAfterSeconds ?? 0) * 1000);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (Date.now() >= readyAt) return undefined;
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= readyAt) clearInterval(timer);
    }, 500);
    return () => clearInterval(timer);
  }, [readyAt]);

  const remaining = Math.max(0, Math.ceil((readyAt - now) / 1000));

  if (kind === 'session') {
    return (
      <button type="button" onClick={onRetry} disabled={!sessionReady}>
        {sessionReady ? 'Start this step again' : 'Verify your session above to continue'}
      </button>
    );
  }

  return (
    <>
      {reconnect && (
        <button type="button" onClick={onReconnect}>
          Reconnect to the job
        </button>
      )}
      {retry !== 'never' && (
        <button
          type="button"
          className={reconnect ? 'secondary' : undefined}
          onClick={onRetry}
          disabled={remaining > 0 || !sessionReady}
        >
          {remaining > 0
            ? `Try again in ${remaining}s`
            : failure.ambiguous
              ? 'Check and try again'
              : 'Try again'}
        </button>
      )}
    </>
  );
}
