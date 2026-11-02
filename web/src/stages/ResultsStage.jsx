import { useCallback, useEffect, useState } from 'react';
import { api, downloadBlob } from '../api.js';
import { OutputCard } from '../components/OutputCard.jsx';
import { CopyButton } from '../components/CopyButton.jsx';
import { Traceability } from '../components/Traceability.jsx';
import { indexDocuments, indexRequirements, useCanonical } from '../state/canonical.jsx';

/**
 * Warning codes whose value the office template's dropdowns do not offer.
 *
 * These no longer stop the export. The row is written with the drafted value
 * intact and the reviewer is told which cells to look at - a visible odd value
 * in the right row is more use to QA than a corrected value nobody chose, or a
 * file that never arrived because of one typo.
 *
 * Codes, not vocabularies. The browser deliberately does not know what a valid
 * case type is: that rule lives on the server, in one place, and duplicating
 * the list here is how the two would drift. EDGE_POLARITY_ON_NON_EDGE is absent
 * because export ignores the field on a non-Edge row - the case is questionable
 * but the workbook is unaffected.
 */
const NEEDS_QA_REVIEW = new Set([
  'EDGE_POLARITY_MISSING',
  'UNRECOGNIZED_EDGE_POLARITY',
  'UNRECOGNIZED_CASE_TYPE',
  'UNRECOGNIZED_PRIORITY',
]);

/**
 * Read-only preview of everything the workflow produced.
 *
 * There is no approve/reject here by design: QATOOL prepares the material, and
 * final human review happens in Excel and in the normal office workflow after
 * export.
 */
/**
 * `detailed` renders the reviewer's tools alongside the result: the semantic
 * review, per-case review notes, and the warnings that are not about coverage.
 * The app does not set it, so the default page shows requirement-level coverage
 * only. Every check behind those sections still runs either way - this decides
 * what is shown, never what is computed.
 */
export function ResultsStage({ onDownloaded, detailed = false }) {
  const { canonical, validation, generation, run, actions } = useCanonical();
  const [error, setError] = useState(null);
  const [details, setDetails] = useState([]);
  const [busy, setBusy] = useState(false);
  const [tracing, setTracing] = useState(null);
  const [reviewing, setReviewing] = useState(false);
  const [reviewError, setReviewError] = useState(null);

  const { project, test_cases: testCases } = canonical;
  const requirements = indexRequirements(canonical.requirements);
  const documents = indexDocuments(canonical.documents);

  // The sample workflow skips Processing, so validate on arrival if nothing has.
  const validate = useCallback(async () => {
    try {
      actions.setValidation(await api.validate(canonical));
    } catch {
      // A failed check must not hide the outputs; export re-checks anyway.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canonical]);

  useEffect(() => {
    if (!validation) validate();
  }, [validation, validate]);

  /**
   * Runs, or re-runs, the LLM semantic review on its own. Nothing is
   * regenerated and nothing is changed: the findings are replaced, the test
   * cases are not.
   */
  async function runSemanticReview() {
    setReviewing(true);
    setReviewError(null);
    try {
      // The model the run was started with, not whatever is selected now.
      actions.setValidation(
        await api.validate(canonical, { semantic: true, provider: run?.provider ?? null })
      );
    } catch (cause) {
      setReviewError(cause.message);
    } finally {
      setReviewing(false);
    }
  }

  async function handleExport() {
    setBusy(true);
    setError(null);
    setDetails([]);
    try {
      const { blob, filename, rowCount } = await api.exportWorkbook(canonical);
      downloadBlob(blob, filename);
      onDownloaded({ filename, rowCount });
    } catch (cause) {
      setError(cause.message);
      setDetails(Array.isArray(cause.details) ? cause.details : []);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Coverage is only meaningful once test cases exist.
   *
   * With none generated, every requirement is trivially uncovered, so the
   * validator quite correctly reports the whole list - and the page fills with
   * warnings that say nothing about the project, only that generation has not
   * run. Before generation, coverage is not "bad", it is not yet evaluated.
   */
  const hasTestCases = testCases.length > 0;

  const structuralIssues = validation
    ? [...validation.schema_issues, ...validation.reference_issues]
    : [];
  const caseWarnings = testCases.flatMap((testCase) =>
    testCase.warnings.map((warning) => ({ caseId: testCase.case_id, ...warning }))
  );
  /**
   * Cases that carry a value the template's dropdowns do not offer.
   *
   * They export, with the drafted value intact. Listing them here is so QA
   * knows where to look in the workbook, not a warning that anything failed.
   */
  const needsQaReview = testCases.filter((testCase) =>
    testCase.warnings.some((warning) => NEEDS_QA_REVIEW.has(warning.code))
  );

  // Findings about meaning. Never blocking, never applied - read and decided on
  // by QA, like everything else on this page.
  const semanticIssues = hasTestCases ? (validation?.semantic_warnings ?? []) : [];

  /**
   * Requirements that are cited but incomplete.
   *
   * The old report had two states, covered and not, and "covered" hid the
   * interesting case: a requirement stating six things with one test case
   * against it. These are the ones worth a reviewer's time, so they are listed
   * with what is missing rather than counted.
   */
  const coverageById = new Map(
    (validation?.coverage?.entries ?? []).map((entry) => [entry.requirement_id, entry])
  );
  const partiallyCovered = hasTestCases
    ? (validation?.coverage?.entries ?? []).filter(
        (entry) => entry.obligations?.state === 'partial'
      )
    : [];
  const issuesByCase = new Map();
  for (const issue of semanticIssues) {
    if (!issue.testcase_id) continue;
    issuesByCase.set(issue.testcase_id, (issuesByCase.get(issue.testcase_id) ?? 0) + 1);
  }
  const scopeText = project.sit_scope.map((point) => `- ${point}`).join('\n');

  return (
    <>
      {error && (
        <div className="notice error">
          <strong>{error}</strong>
          {details.length > 0 && (
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {details.map((detail, index) => (
                <li key={index}>{detail.message ?? JSON.stringify(detail)}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="card">
        <h2>{project.project_name || 'Results'}</h2>
        <div className="metrics">
          <div className="metric">
            <div className="value">{testCases.length}</div>
            <div className="label">Test cases</div>
          </div>
          <div className="metric">
            <div className="value">{canonical.requirements.length}</div>
            <div className="label">Requirements</div>
          </div>
          <div className="metric">
            <div className="value">{canonical.documents.length}</div>
            <div className="label">Documents</div>
          </div>
          <div className="metric">
            <div className="value">
              {hasTestCases ? (validation?.coverage.uncovered.length ?? '—') : '—'}
            </div>
            <div className="label">{hasTestCases ? 'Uncovered reqs' : 'Coverage'}</div>
          </div>
        </div>

        {generation?.metadata && (
          <p className="muted" style={{ marginTop: 12, marginBottom: 0, fontSize: 13 }}>
            Drafted by {generation.metadata.provider} ({generation.metadata.model}) from{' '}
            {generation.metadata.requirement_count} requirements in{' '}
            {(generation.metadata.duration_ms / 1000).toFixed(1)}s
            {generation.metadata.duplicates_removed > 0 &&
              `, ${generation.metadata.duplicates_removed} duplicate(s) removed`}
            . Review before use.
          </p>
        )}

        <div className="row" style={{ marginTop: 16 }}>
          <button type="button" onClick={handleExport} disabled={busy || !hasTestCases}>
            {busy ? 'Generating...' : 'Download SIT Script.xlsx'}
          </button>
          {!hasTestCases && <span className="muted">Generate test cases before exporting.</span>}
        </div>
      </div>

      <Warnings
        hasTestCases={hasTestCases}
        detailed={detailed}
        structurallyValid={validation ? validation.valid !== false : true}
        structuralIssues={structuralIssues}
        caseWarnings={caseWarnings}
        needsQaReview={needsQaReview}
        uncovered={hasTestCases ? (validation?.coverage.uncovered ?? []) : []}
        partiallyCovered={partiallyCovered}
        coverageById={coverageById}
        requirements={requirements}
      />

      {detailed && hasTestCases && (
        <SemanticReview
          issues={semanticIssues}
          status={validation?.semantic ?? null}
          busy={reviewing}
          error={reviewError}
          onRun={runSemanticReview}
        />
      )}

      <OutputCard
        title="Project Description"
        hint="One sentence, suitable as a project description"
        value={project.project_description}
      />
      <OutputCard
        title="Project Summary"
        hint="What the project is"
        value={project.project_summary}
      />
      <OutputCard
        title="QA Guidance"
        hint="What QA should focus on during SIT"
        value={project.qa_guidance}
      />
      <OutputCard title="SIT Scope" hint="3-5 points derived from coverage" value={scopeText}>
        <ul className="scope">
          {project.sit_scope.map((point, index) => (
            <li key={index}>{point}</li>
          ))}
        </ul>
      </OutputCard>
      <OutputCard
        title="Project Background"
        hint="One paragraph, suitable for SIT circulation"
        value={project.project_background}
      />

      <div className="card">
        <div className="output-head">
          <h2>Test cases &amp; traceability</h2>
          <CopyButton
            value={testCases
              .map(
                (testCase) =>
                  `${testCase.case_id}\t${testCase.section}\t${testCase.test_case}\t${testCase.expected_result}`
              )
              .join('\n')}
            label="Copy as TSV"
          />
        </div>

        {testCases.length === 0 ? (
          <p className="muted">No test cases generated yet.</p>
        ) : (
          testCases.map((testCase) => (
            <div className="case-row" key={testCase.case_id}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'start' }}>
                <div style={{ flex: 1, minWidth: 240 }}>
                  <span className="badge mono">{testCase.case_id}</span>{' '}
                  {/* The value the model actually produced, marked when it is
                      outside the recommended vocabulary. Never a corrected
                      version of it: QA cannot review a decision it cannot see. */}
                  <span
                    className={flaggedFields(testCase).has('case_type') ? 'badge warn' : 'badge'}
                  >
                    {testCase.case_type}
                  </span>{' '}
                  {(testCase.case_type === 'Edge' || testCase.edge_polarity) && (
                    <>
                      <span
                        className={
                          flaggedFields(testCase).has('edge_polarity') ? 'badge warn' : 'badge'
                        }
                      >
                        {testCase.edge_polarity ?? 'polarity missing'}
                      </span>{' '}
                    </>
                  )}
                  <span
                    className={flaggedFields(testCase).has('priority') ? 'badge warn' : 'badge'}
                  >
                    {testCase.priority}
                  </span>{' '}
                  <span className="badge">{testCase.type}</span>{' '}
                  <span className="badge">confidence: {testCase.confidence}</span>
                  {detailed && issuesByCase.has(testCase.case_id) && (
                    <>
                      {' '}
                      <span className="badge warn">
                        {issuesByCase.get(testCase.case_id)} review note
                        {issuesByCase.get(testCase.case_id) === 1 ? '' : 's'}
                      </span>
                    </>
                  )}
                </div>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setTracing(tracing === testCase.case_id ? null : testCase.case_id)}
                >
                  {tracing === testCase.case_id ? 'Hide trace' : 'Trace'}
                </button>
              </div>

              <div className="section-label">{testCase.section}</div>
              <strong>{testCase.test_case}</strong>
              <pre className="expected">{testCase.expected_result}</pre>

              {/* Shown here, next to the value it is about, rather than only in
                  the warnings card. A reviewer deciding whether 'Positiv' should
                  be Positive needs the action and the expected result in front
                  of them, not a case id in a list further up the page. */}
              {testCase.warnings.length > 0 && (
                <ul className="issues case-notes">
                  {testCase.warnings.map((warning, index) => (
                    <li key={index}>
                      <span aria-hidden="true">⚠ </span>
                      {warning.field && <strong>{fieldLabel(warning.field)}: </strong>}
                      {warning.message}
                    </li>
                  ))}
                </ul>
              )}

              {tracing === testCase.case_id && (
                <Traceability
                  testCase={testCase}
                  requirements={requirements}
                  documents={documents}
                />
              )}
            </div>
          ))
        )}
      </div>
    </>
  );
}

/**
 * One requirement in a coverage warning: what it is, and how much of what it
 * states the generated test cases cover.
 *
 * "Covered", never "tested". Nothing on this page has been executed: a
 * behaviour is covered when a generated test case is written to exercise it,
 * and saying "tested" claimed a run that never happened.
 */
function CoverageRow({ requirementId, title, covered, total, emphasis = false }) {
  return (
    <li>
      <div>
        <span className={emphasis ? 'badge warn mono' : 'badge mono'}>{requirementId}</span>
        {title ? <> {title}</> : null}
      </div>
      {total > 0 && (
        <div className="muted">
          {covered} of {total} behaviours covered
        </div>
      )}
    </li>
  );
}

/**
 * The Warnings card.
 *
 * By default it carries one kind of warning, at one level: which requirements
 * the generated test cases do not fully cover, and by how much. Each
 * requirement appears once. The individual behaviours, the per-case notes and
 * the semantic review read as noise beside that figure - several lines saying
 * the same thing about the same requirement - and they are a reviewer's tools
 * rather than the result.
 *
 * Nothing is computed differently or dropped upstream. Every check still runs
 * and its findings are still returned; `detailed` renders them. A case's
 * questionable dropdown value is still marked on the case itself, and export
 * still lists any structural problem when it refuses.
 */
function Warnings({
  hasTestCases,
  detailed = false,
  structurallyValid = true,
  structuralIssues,
  caseWarnings,
  needsQaReview,
  uncovered,
  partiallyCovered = [],
  coverageById = new Map(),
  requirements = new Map(),
}) {
  const total =
    uncovered.length +
    partiallyCovered.length +
    (detailed ? structuralIssues.length + caseWarnings.length + needsQaReview.length : 0);

  return (
    <div className="card">
      <h2>{total === 0 ? 'Warnings' : `Warnings (${total})`}</h2>

      {/* "No warnings" would be a clean bill of health that nothing has earned
          yet: before generation there is nothing to warn about. Nor has it been
          earned by a project that failed structural validation - its coverage
          is not evaluated at all, so an empty list here means nothing. */}
      {!hasTestCases && <p className="muted">Test cases not generated yet.</p>}
      {hasTestCases &&
        total === 0 &&
        (structurallyValid ? (
          <span className="badge ok">No warnings</span>
        ) : (
          <p className="muted">
            Coverage could not be evaluated: the project did not pass structural validation. Export
            lists the problems.
          </p>
        ))}

      {detailed && needsQaReview.length > 0 && (
        <div className="notice">
          <strong>
            {needsQaReview.length} test case{needsQaReview.length === 1 ? '' : 's'} contain
            {needsQaReview.length === 1 ? 's' : ''} QA-review warnings. They were preserved in the
            export unchanged.
          </strong>{' '}
          {needsQaReview.map((testCase) => testCase.case_id).join(', ')} carry a Case Type, Priority
          or Edge polarity the workbook&rsquo;s dropdowns do not offer. The drafted value was
          written to the cell as-is &mdash; nothing was converted, inferred or removed &mdash; so
          review and set these in Excel.
        </div>
      )}

      {detailed && structuralIssues.length > 0 && (
        <>
          <h3 className="warn-head">Structural</h3>
          <ul className="issues">
            {structuralIssues.map((issue, index) => (
              <li key={index}>
                <code>{issue.path}</code> &mdash; {issue.message}
              </li>
            ))}
          </ul>
        </>
      )}

      {uncovered.length > 0 && (
        <>
          <h3 className="warn-head">Uncovered requirements</h3>
          <p className="muted" style={{ marginTop: -4 }}>
            No generated test case references these requirements.
          </p>
          <ul className="coverage-list">
            {uncovered.map((requirementId) => (
              <CoverageRow
                key={requirementId}
                requirementId={requirementId}
                title={requirements.get(requirementId)?.title}
                covered={0}
                total={coverageById.get(requirementId)?.obligations?.total ?? 0}
                emphasis
              />
            ))}
          </ul>
        </>
      )}

      {partiallyCovered.length > 0 && (
        <>
          <h3 className="warn-head">Partially covered requirements</h3>
          <p className="muted" style={{ marginTop: -4 }}>
            The generated test cases do not cover all behaviours stated in these requirements.
          </p>
          <ul className="coverage-list">
            {partiallyCovered.map((entry) => (
              <CoverageRow
                key={entry.requirement_id}
                requirementId={entry.requirement_id}
                title={requirements.get(entry.requirement_id)?.title}
                covered={entry.obligations.covered}
                total={entry.obligations.total}
              />
            ))}
          </ul>
        </>
      )}

      {detailed && caseWarnings.length > 0 && (
        <>
          <h3 className="warn-head">Per test case</h3>
          <ul className="issues">
            {caseWarnings.map((warning, index) => (
              <li key={index}>
                <span className="mono">{warning.caseId}</span> &mdash;{' '}
                <strong>{warning.code}</strong> {warning.message}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * Which of this case's fields a warning is about, so the badge showing the
 * value can be marked without the page re-deriving the rule the server applied.
 */
function flaggedFields(testCase) {
  return new Set(testCase.warnings.map((warning) => warning.field).filter(Boolean));
}

const FIELD_LABELS = {
  case_type: 'Case Type',
  priority: 'Priority',
  edge_polarity: 'Edge Polarity',
};

const fieldLabel = (field) => FIELD_LABELS[field] ?? field;

const CATEGORY_LABELS = {
  contradiction: 'Contradicts requirement',
  unsupported_behavior: 'Behaviour not in requirement',
  hallucinated_detail: 'Possibly invented detail',
  unsupported_implementation_detail: 'Unsupported implementation detail',
  duplicate: 'Possible duplicate',
  missing_coverage: 'Missing coverage',
  suspicious_edge_polarity: 'Suspicious Edge polarity',
  suspicious_case_type: 'Suspicious case type',
  no_meaningful_test: 'No meaningful test',
};

const SEVERITY_BADGE = { high: 'badge danger', medium: 'badge warn', low: 'badge' };

function detectedBy(sources = []) {
  if (sources.includes('heuristic') && sources.includes('llm')) return 'AI review + rule check';
  return sources.includes('llm') ? 'AI review' : 'rule check';
}

/**
 * What the semantic review found, and what did or did not run to find it.
 *
 * Saying what did not run matters as much as the findings: an empty list after
 * a failed AI review is not a clean bill of health, and the page must not let
 * it read like one.
 */
function SemanticReview({ issues, status, busy, error, onRun }) {
  const llm = status?.llm ?? 'not_requested';

  return (
    <div className="card">
      <div className="output-head">
        <h2>{issues.length === 0 ? 'Semantic review' : `Semantic review (${issues.length})`}</h2>
        {(llm === 'failed' || llm === 'not_requested') && (
          <button type="button" className="secondary" onClick={onRun} disabled={busy}>
            {busy ? 'Reviewing...' : llm === 'failed' ? 'Retry AI review' : 'Run AI review'}
          </button>
        )}
      </div>

      <p className="muted" style={{ marginTop: -4 }}>
        Concerns about meaning, for QA to judge. Nothing here changes a test case or blocks export.
      </p>

      {llm === 'completed' && (
        <p className="semantic-meta">
          Checked by rules and by an AI review ({status.provider}, {status.model}).
          {status.discarded_issues > 0 &&
            ` ${status.discarded_issues} AI finding(s) discarded for citing ids that do not exist.`}
        </p>
      )}

      {llm === 'failed' && (
        <div className="notice">
          <strong>The AI review did not run.</strong> {status.error?.message} Only the rule checks
          below were applied, so an empty list here is not a clean result. Retrying reviews the same
          test cases; nothing is regenerated.
        </div>
      )}

      {llm === 'not_requested' && (
        <p className="semantic-meta">
          Only the rule checks have run. The AI review has not been run for this workflow.
        </p>
      )}

      {error && (
        <div className="notice error">
          <strong>{error}</strong>
        </div>
      )}

      {issues.length === 0 ? (
        llm === 'completed' ? (
          <span className="badge ok">No semantic concerns found</span>
        ) : (
          <p className="muted">No concerns from the rule checks.</p>
        )
      ) : (
        <ul className="semantic-list">
          {issues.map((issue, index) => (
            <li key={index}>
              <span className={SEVERITY_BADGE[issue.severity] ?? 'badge'}>{issue.severity}</span>{' '}
              <strong>{CATEGORY_LABELS[issue.category] ?? issue.category}</strong>{' '}
              {issue.testcase_id && <span className="badge mono">{issue.testcase_id}</span>}{' '}
              {issue.requirement_id && <span className="badge mono">{issue.requirement_id}</span>}
              <div>{issue.explanation}</div>
              <div className="semantic-meta">{detectedBy(issue.detected_by)}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
