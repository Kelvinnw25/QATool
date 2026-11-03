import { AppError } from '../lib/errors.js';

/**
 * Every pipeline endpoint takes the same envelope. Checking its shape here
 * keeps the error identical across endpoints instead of each one failing in its
 * own way on a malformed body.
 */
export function requireCanonical(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(
      'BAD_REQUEST',
      'Expected a canonical project object in the request body.',
      400
    );
  }

  return {
    project: body.project ?? {},
    documents: Array.isArray(body.documents) ? body.documents : [],
    requirements: Array.isArray(body.requirements) ? body.requirements : [],
    test_cases: Array.isArray(body.test_cases) ? body.test_cases : [],
  };
}
