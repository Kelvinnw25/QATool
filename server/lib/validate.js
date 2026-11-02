import { validationFailed, zodIssues } from './errors.js';

/**
 * Parses with a Zod schema or throws a controlled AppError.
 *
 * Every write path goes through this, so an invalid payload can never reach a
 * repository: the canonical model is guarded at the boundary, not by hoping
 * callers behave.
 */
export function parseOrThrow(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw validationFailed(zodIssues(result.error));
  }
  return result.data;
}

/** Non-throwing variant for the validation engine in milestone 5. */
export function collectIssues(schema, data) {
  const result = schema.safeParse(data);
  return result.success ? [] : zodIssues(result.error);
}
