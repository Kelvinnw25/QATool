import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApiError } from '../api.js';
import { checkUploadLimits } from './limits.js';
import { describeFailure, userMessage } from './failure.js';

const api = (status, code, retryAfterSeconds = null) =>
  new ApiError(
    status,
    { error: { code, message: `${code} from the server` } },
    { retryAfterSeconds, demo: true }
  );

describe('what a visitor is told', () => {
  it('UPLOAD_BUSY: files are kept, try again soon', () => {
    const d = describeFailure(api(429, 'UPLOAD_BUSY', 2));
    assert.equal(d.kind, 'upload_busy');
    assert.equal(d.retry, 'later');
    assert.match(d.message, /still here/);
    assert.match(d.message, /2 seconds/);
  });

  it('QUEUE_FULL: input is retained, wait the Retry-After', () => {
    const d = describeFailure(api(429, 'QUEUE_FULL', 30));
    assert.equal(d.kind, 'queue_full');
    assert.equal(d.retryAfterSeconds, 30);
    assert.match(d.message, /queue is full/);
    assert.match(d.message, /documents are still here/);
    assert.match(d.message, /30 seconds/);
  });

  it('SERVICE_PAUSED: the AI service is paused, not the visitor’s fault', () => {
    const d = describeFailure(api(503, 'SERVICE_PAUSED', 45));
    assert.equal(d.kind, 'paused');
    assert.match(d.message, /paused/);
    assert.match(d.message, /resumes by itself/);
    assert.equal(d.retry, 'later');
  });

  it('401: session ended, verify again, retry is not offered until then', () => {
    const d = describeFailure(api(401, 'UNAUTHENTICATED'));
    assert.equal(d.kind, 'session');
    assert.match(d.message, /Verify again/);
    assert.equal(d.retry, 'never');
  });

  it('403: refused origin, with a useful and honest message', () => {
    const d = describeFailure(api(403, 'ORIGIN_FORBIDDEN'));
    assert.equal(d.kind, 'forbidden');
    assert.match(d.message, /refused this site/);
    assert.match(d.message, /retrying will not fix/);
  });

  it('404: an unknown job is "lost", with the work still safe in the page', () => {
    const d = describeFailure(api(404, 'JOB_NOT_FOUND'));
    assert.equal(d.kind, 'lost');
    assert.match(d.message, /expired|restarted/);
    assert.match(d.message, /still in this page/);
  });

  it('a server shutdown is explained as a restart, not as the visitor cancelling', () => {
    const d = describeFailure({ kind: 'shutdown' });
    assert.equal(d.kind, 'shutdown');
    assert.match(d.message, /restarting/);
    assert.match(d.message, /not something you did/);
    assert.match(d.message, /still in this page/);
    assert.match(d.message, /start the step again/);
    assert.doesNotMatch(d.message, /was cancelled/);
    assert.equal(d.retry, 'later');
    assert.equal(d.retryAfterSeconds, 15, 'the retry button waits before resubmitting');
  });

  it('distinguishes inactivity and a restart from a plain 404', () => {
    assert.equal(describeFailure({ kind: 'inactive' }).kind, 'inactive');
    assert.match(describeFailure({ kind: 'inactive' }).message, /foreground/);
    assert.equal(describeFailure({ kind: 'restarted' }).kind, 'restarted');
    assert.match(describeFailure({ kind: 'restarted' }).message, /restarted/);
  });

  it('413 / 422 / 400: the document is the problem, a retry will not help', () => {
    for (const [status, code] of [
      [413, 'FILE_TOO_LARGE'],
      [422, 'EXTRACTION_FAILED'],
      [400, 'BAD_REQUEST'],
    ]) {
      const d = describeFailure(api(status, code));
      assert.equal(d.retry, 'never', code);
    }
    assert.equal(describeFailure(api(413, 'FILE_TOO_LARGE')).kind, 'too_large');
    assert.equal(describeFailure(api(422, 'EXTRACTION_FAILED')).kind, 'invalid');
  });

  it('429 RATE_LIMITED gives retry guidance', () => {
    const d = describeFailure(api(429, 'RATE_LIMITED', 8));
    assert.equal(d.kind, 'rate_limited');
    assert.match(d.message, /8 seconds/);
  });

  it('503 / 504 are the service and the timeout, not the same thing', () => {
    assert.equal(describeFailure(api(503, 'SERVICE_UNAVAILABLE', 15)).kind, 'unavailable');
    assert.equal(describeFailure(api(504, 'JOB_DEADLINE_EXCEEDED')).kind, 'timeout');
    assert.match(describeFailure(api(504, 'JOB_DEADLINE_EXCEEDED')).message, /took too long/);
  });

  it('a network error is "offline", never a development-server message', () => {
    const d = describeFailure(new ApiError(0, null, { demo: true, networkFailure: true }));
    assert.equal(d.kind, 'offline');
    assert.doesNotMatch(d.message, /vite|development|proxy/i);
  });

  it('a job that failed on the server keeps its own sentence and its retryability', () => {
    const error = Object.assign(new Error('The model provider is temporarily unavailable.'), {
      code: 'LLM_UNAVAILABLE',
      retryable: true,
      fromJob: true,
    });
    const d = describeFailure(error);
    assert.equal(d.kind, 'job');
    assert.equal(d.message, 'The model provider is temporarily unavailable.');
    assert.equal(d.retry, 'later');
    assert.equal(describeFailure(Object.assign(error, { retryable: false })).retry, 'never');
  });

  it('JOB_ALREADY_ACTIVE explains the one-job rule', () => {
    const d = describeFailure(api(409, 'JOB_ALREADY_ACTIVE'));
    assert.equal(d.kind, 'conflict');
    assert.match(d.message, /already have a different job/);
  });

  it('names no provider, address or gateway in anything it says', () => {
    const codes = [
      ['UPLOAD_BUSY', 429],
      ['QUEUE_FULL', 429],
      ['SERVICE_PAUSED', 503],
      ['SERVICE_UNAVAILABLE', 503],
      ['UNAUTHENTICATED', 401],
      ['ORIGIN_FORBIDDEN', 403],
      ['JOB_NOT_FOUND', 404],
      ['RATE_LIMITED', 429],
      ['JOB_DEADLINE_EXCEEDED', 504],
    ];
    for (const [code, status] of codes) {
      assert.doesNotMatch(
        describeFailure(api(status, code)).message,
        /claude|apayee|gemini|anthropic|gateway|localhost|127\.0/i,
        code
      );
    }
  });

  it('leaves the local tool’s messages exactly as the server sent them', () => {
    const error = new ApiError(422, {
      error: { code: 'NO_REQUIREMENTS', message: 'Nothing found.' },
    });
    assert.equal(userMessage(error, { demo: false }), 'Nothing found.');
    assert.notEqual(
      userMessage(api(401, 'UNAUTHENTICATED'), { demo: true }),
      'UNAUTHENTICATED from the server'
    );
  });
});

describe('upload limits announced by the session', () => {
  const limits = {
    max_files: 3,
    max_file_bytes: 10 * 1024 * 1024,
    max_total_bytes: 20 * 1024 * 1024,
  };
  const file = (name, size) => ({ name, size });

  it('accepts files within every limit, and when no limits are known', () => {
    assert.deepEqual(checkUploadLimits([file('a', 1000)], limits), []);
    assert.deepEqual(checkUploadLimits([file('a', 10 ** 12)], null), []);
  });

  it('reports each limit that is broken', () => {
    const problems = checkUploadLimits(
      [file('big.pdf', 11 * 1024 * 1024), file('b', 1), file('c', 1), file('d', 1)],
      limits
    );
    assert.ok(problems.some((p) => /Too many files/.test(p)));
    assert.ok(problems.some((p) => /big\.pdf is too large/.test(p)));
  });

  it('reports a total that is too large even when each file fits', () => {
    const problems = checkUploadLimits(
      [file('a', 9 * 1024 * 1024), file('b', 9 * 1024 * 1024), file('c', 9 * 1024 * 1024)],
      limits
    );
    assert.deepEqual(problems.length, 1);
    assert.match(problems[0], /together/);
  });
});
