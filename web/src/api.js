/**
 * Client for the stateless pipeline.
 *
 * Every call posts the canonical object and returns what the server computed
 * from it. Nothing is stored on either side.
 */
/**
 * Every error the API itself reports arrives as {error: {code, message}} - the
 * server's error handler has no other branch, so a failed response WITHOUT that
 * shape did not come from the API at all. Saying "Request failed with status
 * 500" for both hid the difference, and the two have nothing in common:
 *
 *   a QATOOL error   the pipeline ran and refused. The message says why and the
 *                    run_id ties it to the server log.
 *   no body at all   nothing answered. In development this is the dev proxy
 *                    reporting that the API is not there: `node --watch`
 *                    replaces the process on any file change, and extraction
 *                    takes tens of seconds, so a save during an upload kills
 *                    the request in flight. Measured: HTTP 500, text/plain,
 *                    zero bytes, and a new server pid in the log.
 *
 * That was read as an extraction failure for two days. The status alone cannot
 * distinguish them, so the message has to.
 */
const NO_RESPONSE =
  'The API did not respond, so this request never reached the pipeline. In development the API ' +
  'restarts whenever a server file changes, which aborts any upload in progress - check that it ' +
  'is running, then retry. Nothing was lost and nothing needs re-uploading.';

export class ApiError extends Error {
  constructor(status, body) {
    const payload = body?.error ?? {};
    const unanswered = typeof payload.message !== 'string';

    super(unanswered ? `${NO_RESPONSE} (HTTP ${status}.)` : payload.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = payload.code ?? (unanswered ? 'API_NOT_RESPONDING' : 'UNKNOWN');
    this.details = payload.details;
    /** Whether the API answered at all, for callers that retry. */
    this.unanswered = unanswered;
  }
}

/**
 * Adds the run's model to a path. Null adds nothing, which is a request that
 * leaves the choice to the server, exactly as before models could be chosen.
 */
function withProvider(path, provider) {
  if (!provider) return path;
  return `${path}${path.includes('?') ? '&' : '?'}provider=${encodeURIComponent(provider)}`;
}

async function request(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 204) return null;

  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, payload);
  return payload;
}

function filenameFrom(disposition, fallback) {
  const match = /filename="([^"]+)"/.exec(disposition ?? '');
  return match ? match[1] : fallback;
}

export const api = {
  health: () => request('GET', '/api/health'),

  /** Which models can be chosen for a run, and whether each can be used right now. */
  providers: () => request('GET', '/api/llm/providers'),

  /** A fixed canonical project, for trying the Results and Download steps
   *  without documents and without an LLM call. */
  sampleCanonical: () => request('GET', '/api/meta/sample-canonical'),

  /**
   * Uploads the chosen documents. No Content-Type header is set: the browser
   * must add its own multipart boundary.
   */
  async extract(files, { provider = null } = {}) {
    const form = new FormData();
    for (const file of files) form.append('documents', file, file.name);

    const response = await fetch(withProvider('/api/extract', provider), {
      method: 'POST',
      body: form,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new ApiError(response.status, payload);
    return payload;
  },

  generate: (canonical, testPoints = [], { provider = null } = {}) =>
    request('POST', withProvider('/api/generate', provider), {
      ...canonical,
      test_points: testPoints,
    }),
  /**
   * Deterministic validation always; the LLM semantic review only when asked.
   * Kept opt-in so that re-validating - the sample workflow, returning to
   * Results - never spends a model call the user did not start.
   */
  validate: (canonical, { semantic = false, testPoints = [], provider = null } = {}) =>
    request(
      'POST',
      withProvider(semantic ? '/api/validate?semantic=true' : '/api/validate', provider),
      { ...canonical, test_points: testPoints }
    ),

  /**
   * Returns the workbook as a Blob plus the filename the server chose, so the
   * naming rule lives in one place rather than being guessed at again here.
   */
  async exportWorkbook(canonical) {
    const response = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(canonical),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new ApiError(response.status, payload);
    }

    return {
      blob: await response.blob(),
      filename: filenameFrom(response.headers.get('Content-Disposition'), 'SIT Script.xlsx'),
      rowCount: Number(response.headers.get('X-QATOOL-Row-Count') ?? 0),
      warningCount: Number(response.headers.get('X-QATOOL-Export-Warnings') ?? 0),
    };
  },
};

/** Hands the generated workbook to the browser's download machinery. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
