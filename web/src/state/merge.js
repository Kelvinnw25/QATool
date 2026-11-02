/**
 * Folds one pipeline phase's output into the project, leaving earlier phases
 * intact so a later failure never costs the work already done.
 *
 * Pure, and the only definition of the merge. The provider applies it to React
 * state and the pipeline runner applies it to the copy it posts to the next
 * phase; two implementations could drift, and then the project the server
 * validates would stop being the project the user is shown.
 */
export function mergeCanonical(current, partial) {
  return {
    ...current,
    ...partial,
    project: { ...current.project, ...(partial.project ?? {}) },
  };
}
