/**
 * What to tell a visitor when something about a job goes wrong.
 *
 * One table, keyed on what the backend actually sends (`error.code`, then the HTTP status), so a
 * stage never writes its own wording and two stages cannot disagree. Every message is written for
 * someone who has never seen the code: what happened, whether their work is safe, and what to do.
 *
 * The backend's own `message` is already free of provider and gateway text (it is built for exactly
 * this audience), so it is used where it says enough and replaced where this page can say more.
 *
 * Plain JavaScript; no React.
 */

/** @typedef {'shutdown'|'upload_busy'|'queue_full'|'paused'|'rate_limited'|'unavailable'|'timeout'|'offline'|'session'|'forbidden'|'too_large'|'invalid'|'conflict'|'lost'|'inactive'|'restarted'|'cancelled'|'job'|'unknown'} FailureKind */

const seconds = (value) => (Number.isFinite(value) && value > 0 ? Math.ceil(value) : null);

const inSeconds = (value, fallback) => {
  const n = seconds(value);
  return n === null ? fallback : `about ${n} second${n === 1 ? '' : 's'}`;
};

/**
 * @param {any} error  an ApiError, or a job failure built by jobs/run.js
 * @returns {{ kind: FailureKind, message: string, retry: 'now' | 'later' | 'never', retryAfterSeconds: number | null, reconnect: boolean }}
 *   `retry`: 'now' a retry is reasonable at once, 'later' after the wait, 'never' it will not help
 *   unless something changes (a new session, a different file). `reconnect`: the job may still be
 *   running and can be followed again without submitting anything.
 */
export function describeFailure(error) {
  const code = error?.code;
  const status = error?.status;
  const wait = seconds(error?.retryAfterSeconds);
  const base = (kind, message, retry, extra = {}) => ({
    kind,
    message,
    retry,
    retryAfterSeconds: wait,
    reconnect: false,
    ...extra,
  });

  if (error?.kind === 'inactive') {
    return base(
      'inactive',
      'This job was stopped because the page stopped checking on it for too long (a background ' +
        'or sleeping tab can do that). Nothing was kept on the server. Keep this tab in the ' +
        'foreground while a job runs, then start the step again.',
      'now'
    );
  }

  if (error?.kind === 'shutdown') {
    return base(
      'shutdown',
      'The demo server is restarting, so your job was stopped. This is not something you did, ' +
        'and nothing is wrong with your files. Your documents and anything already extracted are ' +
        'still in this page. Wait a minute for the server to come back, then start the step ' +
        'again; it will run from the beginning of that step.',
      'later',
      // The button counts this down, so the retry is not sent at a server that is still coming up.
      { retryAfterSeconds: 15 }
    );
  }

  if (error?.kind === 'restarted') {
    return base(
      'restarted',
      'The demo server restarted, so your job was lost. Your documents and anything already ' +
        'extracted are still in this page. Start the step again.',
      'now'
    );
  }

  if (error?.kind === 'cancelled') {
    return base('cancelled', 'The job was cancelled. Nothing more will run.', 'now');
  }

  if (code === 'JOB_NOT_FOUND' || error?.kind === 'lost') {
    return base(
      'lost',
      'The job is no longer on the server. It may have expired, or the demo server may have ' +
        'restarted. Your documents and anything already extracted are still in this page. Start ' +
        'the step again.',
      'now'
    );
  }

  if (code === 'UPLOAD_BUSY') {
    return base(
      'upload_busy',
      'The demo is reading other visitors’ uploads right now. Your files are still here. Try ' +
        `again in ${inSeconds(wait, 'a few seconds')}.`,
      'later'
    );
  }

  if (code === 'QUEUE_FULL') {
    return base(
      'queue_full',
      'The demo queue is full right now. Your documents are still here. Try again in ' +
        `${inSeconds(wait, 'a minute')}.`,
      'later'
    );
  }

  if (code === 'SERVICE_PAUSED') {
    return base(
      'paused',
      'The AI service is paused for a short while because it is temporarily unavailable. It ' +
        `resumes by itself. Try again in ${inSeconds(wait, 'a minute')}.`,
      'later'
    );
  }

  if (code === 'RATE_LIMITED' || status === 429) {
    return base(
      'rate_limited',
      `You are sending requests too quickly. Wait ${inSeconds(wait, 'a moment')}, then try again.`,
      'later'
    );
  }

  if (code === 'JOB_ALREADY_ACTIVE') {
    return base(
      'conflict',
      'You already have a different job in progress. Wait for it to finish — if its page was ' +
        'closed it stops on its own within about a minute — then try again.',
      'later'
    );
  }

  if (code === 'UNAUTHENTICATED' || status === 401) {
    return base(
      'session',
      'Your session has ended or is no longer valid. Verify again to continue. A job started ' +
        'under the old session cannot be reattached and stops on its own within about a minute.',
      'never'
    );
  }

  if (code === 'ORIGIN_FORBIDDEN' || status === 403) {
    return base(
      'forbidden',
      'The demo service refused this site. This is a configuration problem on the owner’s side ' +
        '(the site is not on the allowed list) and retrying will not fix it.',
      'never'
    );
  }

  if (status === 413) {
    return base(
      'too_large',
      error?.message && !error.unanswered
        ? `${error.message} Remove or shrink the file and try again.`
        : 'The upload is too large. Remove or shrink a file and try again.',
      'never'
    );
  }

  if (status === 422 || status === 400) {
    return base(
      'invalid',
      error?.message ?? 'The documents could not be used. Check them and try again.',
      'never'
    );
  }

  if (code === 'JOB_DEADLINE_EXCEEDED' || status === 504) {
    return base(
      'timeout',
      'The job took too long and was stopped. Nothing was kept on the server. Try again; if it ' +
        'keeps happening, use fewer or shorter documents.',
      'later'
    );
  }

  if (error?.networkFailure || error?.unanswered) {
    return base(
      'offline',
      error?.networkFailure
        ? error.message
        : 'The QATOOL demo service did not answer. It may be offline or restarting. Nothing you ' +
            'entered was lost.',
      'later',
      { reconnect: error?.jobId != null }
    );
  }

  if (code === 'SERVICE_UNAVAILABLE' || code === 'SERVICE_SHUTTING_DOWN' || status === 503) {
    return base(
      'unavailable',
      'The demo service is not available right now. Try again in ' +
        `${inSeconds(wait, 'a minute')}.`,
      'later'
    );
  }

  if (error?.fromJob) {
    return base(
      'job',
      error.message ?? 'The job could not be completed.',
      error.retryable === false ? 'never' : 'later'
    );
  }

  return base('unknown', error?.message ?? 'Something went wrong.', 'later');
}

/**
 * The sentence a simple error line should show. In the local tool the server's own message is used
 * exactly as before; the table above is for the demo, whose codes it knows.
 */
export function userMessage(error, { demo }) {
  return demo ? describeFailure(error).message : error?.message;
}
