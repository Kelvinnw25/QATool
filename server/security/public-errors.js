import { AppError } from '../lib/errors.js';

/**
 * What an error looks like once it leaves the backend in public mode.
 *
 * Outside public mode nothing changes: the body is exactly what the error says,
 * which is what a developer at the terminal wants. In public mode the reply goes
 * through a network and a browser the backend does not control, so it carries
 * only text written for that audience:
 *
 *  - provider failures are described by their kind, never by what the provider or
 *    the gateway said, and never name a host, a port, an address or a setting;
 *  - errors that echo an uploaded filename or a parser's own message are replaced
 *    by a fixed sentence for their code;
 *  - any other message has addresses and file paths cut out as a last resort;
 *  - the framework's own 4xx errors lose their text, because a JSON syntax error
 *    can quote the body that caused it.
 *
 * The same text is what the log records, so a filename or an internal address
 * does not reach the log either.
 */

export const LLM_MESSAGES = {
  LLM_NOT_CONFIGURED: 'The model provider is not available.',
  LLM_AUTH_FAILED: 'The model provider is not available.',
  LLM_RATE_LIMITED: 'The model provider is limiting requests. Wait, then retry.',
  LLM_TIMEOUT: 'The model did not answer in time. Retry later.',
  LLM_UNAVAILABLE: 'The model provider is temporarily unavailable. Retry later.',
  LLM_MALFORMED_OUTPUT: 'The model returned a reply that could not be used.',
  LLM_TRUNCATED: 'The model returned a reply that could not be used.',
  LLM_REFUSED: 'The model declined the request.',
};

/** Codes whose messages quote the uploaded filename or a parser's internals. */
const DOCUMENT_MESSAGES = {
  EMPTY_DOCUMENT: 'A document is empty.',
  DOCUMENT_TOO_COMPLEX: 'A document has more content than this service can process.',
  UNSUPPORTED_FILE_TYPE: 'A document is not a supported type. Use PDF, DOCX or XLSX.',
  CORRUPT_DOCUMENT: 'A document could not be opened. It may be corrupt.',
  PARSER_FAILURE: 'A document could not be read.',
};

const CLIENT_ERRORS = {
  400: 'The request could not be processed.',
  413: 'The request is too large.',
  415: 'The content type is not supported.',
};

/** Web addresses and file system paths, the two things an internal message tends to leak. */
export function scrub(message) {
  return String(message ?? '')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[address]')
    .replace(/\b[A-Za-z]:\\[^\s'"`]*/g, '[path]')
    .replace(/(^|[\s(`'"])\/(?:[\w.@-]+\/)+[\w.@-]*/g, '$1[path]');
}

/** The reason a model is unavailable, reduced to the two a caller can act on. */
export function coarseReasonCode(code) {
  return code === 'not_configured' ? 'not_configured' : 'unavailable';
}

function publicBody(error) {
  // ProviderUnavailableError: which provider, and only a coarse reason.
  if (typeof error.providerId === 'string') {
    return {
      code: error.code,
      message: 'The selected model is not available right now.',
      provider: error.providerId,
      reason_code: coarseReasonCode(error.reasonCode),
    };
  }

  // Extraction errors carry the uploaded filenames in `details`, and their message
  // is often a document's own message, which quotes the name. The structured
  // `filename` field stays (it is sanitised data the page uses to point at the
  // right file); the text is what must not repeat it.
  const names = Array.isArray(error.details)
    ? error.details
        .map((detail) => detail?.filename)
        .filter((name) => typeof name === 'string' && name.length >= 3)
    : [];
  const mask = (text) =>
    names.reduce((masked, name) => masked.split(name).join('the document'), text);

  const known = LLM_MESSAGES[error.code] ?? DOCUMENT_MESSAGES[error.code];
  const body = { code: error.code, message: known ?? scrub(mask(String(error.message ?? ''))) };

  if (error.details !== undefined) {
    body.details = Array.isArray(error.details)
      ? error.details.map((detail) =>
          typeof detail?.message === 'string'
            ? { ...detail, message: scrub(mask(detail.message)) }
            : detail
        )
      : error.details;
  }
  return body;
}

/**
 * @param {Error & { statusCode?: number, code?: string }} error
 * @param {{ publicMode: boolean }} options
 * @returns {{ expected: false } | { expected: true, status: number, body: object, logMessage: string }}
 *   `expected` is false for an error that is ours and unplanned: the handler logs
 *   and replaces it, as it always has.
 */
export function presentError(error, { publicMode }) {
  if (error instanceof AppError) {
    if (!publicMode) {
      return {
        expected: true,
        status: error.statusCode,
        body: error.toJSON(),
        logMessage: error.message,
      };
    }
    const body = publicBody(error);
    return { expected: true, status: error.statusCode, body, logMessage: body.message };
  }

  // The framework's own client errors: bad JSON, unsupported type, oversized body.
  if (error.statusCode && error.statusCode < 500) {
    const message = publicMode
      ? (CLIENT_ERRORS[error.statusCode] ?? CLIENT_ERRORS[400])
      : error.message;
    return {
      expected: true,
      status: error.statusCode,
      body: { code: error.code ?? 'BAD_REQUEST', message },
      logMessage: message,
    };
  }

  return { expected: false };
}

/**
 * `/api/llm/providers` as a public-mode caller may see it: what can be chosen and
 * whether it can be used, without why. The reasons name the gateway and its state,
 * and the default note names a server setting.
 */
export function publicProviderList(list) {
  return {
    default: list.default ?? null,
    ...(list.default_label ? { default_label: 'Server default' } : {}),
    providers: list.providers.map((provider) => ({
      id: provider.id,
      label: provider.label,
      available: provider.available === true,
      reason: provider.available
        ? null
        : provider.code === 'not_configured'
          ? 'Not configured on the server.'
          : 'Not available right now.',
      code: provider.available ? null : coarseReasonCode(provider.code),
    })),
  };
}
