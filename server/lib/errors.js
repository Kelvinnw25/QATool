/**
 * Controlled application errors.
 *
 * PRD 20/22: the API must return controlled errors rather than leaking stack
 * traces, provider messages or document content. Every error the API emits on
 * purpose goes through AppError so the shape stays predictable:
 *
 *   { error: { code, message, details? } }
 */
export class AppError extends Error {
  constructor(code, message, statusCode = 400, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }

  toJSON() {
    const body = { code: this.code, message: this.message };
    if (this.details !== undefined) body.details = this.details;
    return body;
  }
}

export function notFound(resource, id) {
  return new AppError('NOT_FOUND', `${resource} '${id}' was not found.`, 404);
}

export function badRequest(message, details) {
  return new AppError('BAD_REQUEST', message, 400, details);
}

export function validationFailed(issues) {
  return new AppError('VALIDATION_FAILED', 'The submitted data is not valid.', 400, issues);
}

export function conflict(message, details) {
  return new AppError('CONFLICT', message, 409, details);
}

/**
 * Flattens a ZodError into a compact, field-addressable list so the UI can put
 * each message next to the field that produced it.
 */
export function zodIssues(error) {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    code: issue.code,
    message: issue.message,
  }));
}
