/**
 * The server's copy of the browser's project handling, for the job runner.
 *
 * Today the browser threads the canonical project from one phase to the next
 * (web/src/pipeline.js). A job does the same work on the server, so it needs the same
 * two functions. They are copied, not imported, because the backend image does not
 * ship the web sources, and a test (merge.test.js) holds them equal to the originals so
 * the project a job validates is the project the browser would have posted.
 */

/** web/src/state/canonical.jsx createEmptyCanonical(), with the project name filled in. */
export function createEmptyCanonical(projectName = '') {
  return {
    project: {
      project_name: projectName,
      project_description: null,
      project_summary: null,
      qa_guidance: null,
      project_background: null,
      sit_scope: [],
    },
    documents: [],
    requirements: [],
    test_cases: [],
  };
}

/** web/src/state/merge.js mergeCanonical(): one phase's output folded into the project. */
export function mergeCanonical(current, partial) {
  return {
    ...current,
    ...partial,
    project: { ...current.project, ...(partial.project ?? {}) },
  };
}
