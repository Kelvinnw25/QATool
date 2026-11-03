import { config } from './config.js';
import { ticketStore } from './session/ticket-store.js';

/**
 * Client for the stateless pipeline.
 *
 * Every call posts the canonical object and returns what the server computed
 * from it. Nothing is stored on either side.
 *
 * Every URL, the visitor's bearer ticket and every failure shape are decided in this file and only
 * here. With no VITE_API_BASE_URL the URLs are the relative `/api/...` paths the local tool has
 * always used.
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

/**
 * The same fact for the public demo, where the API is another machine behind a tunnel and there is
 * no Vite proxy. Naming the development server there would send a visitor looking for something
 * that is not theirs to fix.
 */
const DEMO_NO_RESPONSE =
  'The QATOOL demo service did not respond, so this request never reached it. It may be offline ' +
  'or restarting. Nothing you entered was lost; try again in a moment.';

const DEMO_UNREACHABLE =
  'The QATOOL demo service cannot be reached right now. It may be offline, or your connection to ' +
  'it may be down. Nothing you entered was lost; try again in a moment.';

const LOCAL_UNREACHABLE =
  'The browser could not reach the QATOOL API. Check that it is running, then retry. Nothing was ' +
  'lost and nothing needs re-uploading.';

export class ApiError extends Error {
  /**
   * @param {number} status  HTTP status, or 0 when no response came back at all
   * @param {unknown} body  the parsed JSON body, if there was one
   * @param {{ retryAfterSeconds?: number | null, demo?: boolean, networkFailure?: boolean }} [extra]
   */
  constructor(
    status,
    body,
    { retryAfterSeconds = null, demo = false, networkFailure = false } = {}
  ) {
    const payload = body?.error ?? {};
    const unanswered = networkFailure || typeof payload.message !== 'string';

    super(
      networkFailure
        ? demo
          ? DEMO_UNREACHABLE
          : LOCAL_UNREACHABLE
        : unanswered
          ? `${demo ? DEMO_NO_RESPONSE : NO_RESPONSE} (HTTP ${status}.)`
          : payload.message
    );
    this.name = 'ApiError';
    this.status = status;
    this.code =
      payload.code ??
      (networkFailure ? 'NETWORK_ERROR' : unanswered ? 'API_NOT_RESPONDING' : 'UNKNOWN');
    this.details = payload.details;
    /** Whether the API answered at all, for callers that retry. */
    this.unanswered = unanswered;
    /** The browser's fetch itself failed: offline, tunnel down, DNS, a blocked cross-origin reply. */
    this.networkFailure = networkFailure;
    /** From the Retry-After header, in whole seconds; null when the server gave none. */
    this.retryAfterSeconds = retryAfterSeconds;
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

function filenameFrom(disposition, fallback) {
  const match = /filename="([^"]+)"/.exec(disposition ?? '');
  return match ? match[1] : fallback;
}

/** Retry-After as whole seconds (the only form this API sends), or null. */
export function parseRetryAfter(value) {
  if (typeof value !== 'string' || !/^\d{1,6}$/.test(value.trim())) return null;
  return Number(value.trim());
}

const isAbort = (cause) => cause?.name === 'AbortError';

/**
 * The client.
 *
 * @param {object} [options]
 * @param {string} [options.baseUrl]  the API origin; '' keeps relative URLs (local tool, Vite proxy)
 * @param {boolean} [options.demo]  public-demo build: the wording of "nothing answered" changes
 * @param {() => string | null} [options.getTicket]  the visitor's ticket, if there is one
 * @param {() => void} [options.onUnauthorized]  called when a request that carried a ticket got a 401
 * @param {typeof fetch} [options.fetchImpl]  defaults to the global fetch, looked up at call time
 */
export function createApi({
  baseUrl = '',
  demo = false,
  getTicket = () => null,
  onUnauthorized = () => {},
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  const url = (path) => `${baseUrl}${path}`;

  /**
   * One fetch. Adds the bearer ticket when there is one, turns a failed fetch into an ApiError that
   * says so, and leaves aborts alone (they are the caller's own doing).
   */
  async function send(path, { method = 'GET', headers = {}, body, signal, authorize = true } = {}) {
    const ticket = authorize ? getTicket() : null;
    const finalHeaders =
      ticket === null ? headers : { ...headers, Authorization: `Bearer ${ticket}` };

    let response;
    try {
      response = await fetchImpl(url(path), { method, headers: finalHeaders, body, signal });
    } catch (cause) {
      if (isAbort(cause)) throw cause;
      throw new ApiError(0, null, { demo, networkFailure: true });
    }

    if (response.status === 401 && ticket !== null) onUnauthorized();
    return response;
  }

  const failure = (response, payload) =>
    new ApiError(response.status, payload, {
      demo,
      retryAfterSeconds: parseRetryAfter(response.headers?.get?.('Retry-After')),
    });

  async function readJson(response) {
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw failure(response, payload);
    return payload;
  }

  async function request(method, path, body, options = {}) {
    const response = await send(path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...options,
    });

    if (response.status === 204) return null;
    return readJson(response);
  }

  return {
    /** The absolute (or same-origin) URL for an API path. The one place URLs are built. */
    url,
    baseUrl,

    health: () => request('GET', '/api/health'),

    /** Which models can be chosen for a run, and whether each can be used right now. Local only. */
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

      return readJson(
        await send(withProvider('/api/extract', provider), { method: 'POST', body: form })
      );
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
     * Carries the visitor's ticket like every other protected call.
     */
    async exportWorkbook(canonical) {
      const response = await send('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(canonical),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw failure(response, payload);
      }

      return {
        blob: await response.blob(),
        filename: filenameFrom(response.headers.get('Content-Disposition'), 'SIT Script.xlsx'),
        rowCount: Number(response.headers.get('X-QATOOL-Row-Count') ?? 0),
        warningCount: Number(response.headers.get('X-QATOOL-Export-Warnings') ?? 0),
      };
    },

    // --- Public demo -------------------------------------------------------------------------

    /**
     * Trades a Turnstile token for a ticket. The one call that carries no ticket.
     * @returns {Promise<{ ticket: string, expires_at: string, limits: object, poll_interval_ms: number }>}
     */
    createSession: (turnstileToken, { signal } = {}) =>
      request(
        'POST',
        '/api/session',
        { turnstile_token: turnstileToken },
        { signal, authorize: false }
      ),

    /**
     * Submits documents as a job. The form is built here, on every call, so a retry never reuses a
     * body the browser may already have consumed. No model is sent: the server fixes it.
     * @returns {Promise<{ job: object }>}
     */
    async submitDocuments(files, projectName, { signal } = {}) {
      const form = new FormData();
      form.append('project_name', projectName);
      for (const file of files) form.append('documents', file, file.name);
      return readJson(await send('/api/jobs', { method: 'POST', body: form, signal }));
    },

    /**
     * Submits a resume: the project the page already holds, from `from` onward.
     * @returns {Promise<{ job: object }>}
     */
    submitResume: ({ from, canonical, testPoints = [] }, { signal } = {}) =>
      request('POST', '/api/jobs', { from, canonical, test_points: testPoints }, { signal }),

    /** Status. Also what keeps the job alive: the backend's lease is renewed by this call only. */
    jobStatus: (id, { signal } = {}) =>
      request('GET', `/api/jobs/${encodeURIComponent(id)}`, undefined, { signal }),

    jobResult: (id, { signal } = {}) =>
      request('GET', `/api/jobs/${encodeURIComponent(id)}/result`, undefined, { signal }),

    cancelJob: (id, { signal } = {}) =>
      request('POST', `/api/jobs/${encodeURIComponent(id)}/cancel`, undefined, { signal }),
  };
}

/** The page's client, wired to this build's configuration and the in-memory ticket. */
export const api = createApi({
  baseUrl: config.apiBase,
  demo: config.demo,
  getTicket: () => ticketStore.get(),
  onUnauthorized: () => ticketStore.clear('rejected'),
});

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
