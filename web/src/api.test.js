import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApiError } from './api.js';

/**
 * The difference between "the pipeline refused" and "nothing answered".
 *
 * These two were reported to the user with the same sentence, and the cost was
 * two days of looking for an extraction bug that did not exist. What was
 * actually happening, measured end to end: `node --watch` replaces the API
 * process whenever a file under server/ changes, extraction takes 14 to 57
 * seconds, and a save during an upload therefore kills the request in flight.
 * The dev proxy then answers
 *
 *   HTTP 500, content-type text/plain, zero bytes
 *
 * and the UI said "Request failed with status 500." - indistinguishable from a
 * real 500 out of the pipeline, and it named extraction as the failed step.
 *
 * The status cannot separate them; only the body can. Every error the API
 * reports carries {error: {code, message}}, because its error handler has no
 * other branch - so a failed response without that shape did not come from the
 * API. That is the whole rule, and these tests hold it in place.
 */

describe('an error the API reported', () => {
  it('keeps the message the server sent', () => {
    const error = new ApiError(422, {
      error: {
        code: 'NO_REQUIREMENTS_EXTRACTED',
        message: 'The documents were read, but no requirement-like statements were found.',
        run_id: 'QATOOL-20260925-B85039',
      },
    });

    assert.equal(
      error.message,
      'The documents were read, but no requirement-like statements were found.'
    );
    assert.equal(error.code, 'NO_REQUIREMENTS_EXTRACTED');
    assert.equal(error.status, 422);
    assert.equal(error.unanswered, false);
  });

  it('keeps the details a validation failure carries', () => {
    const details = [{ path: 'requirements.0.category', message: 'Invalid enum value.' }];
    const error = new ApiError(400, {
      error: { code: 'INVALID_REQUIREMENTS', message: 'Not valid.', details },
    });

    assert.deepEqual(error.details, details);
  });

  /**
   * A server 500 still reaches the handler and still carries a message, so it
   * must NOT be reported as an unanswered request - it is a real pipeline
   * failure with a server log behind it.
   */
  it('reports a genuine server 500 as the server described it', () => {
    const error = new ApiError(500, {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An internal error occurred. Check the server log for details.',
        run_id: 'QATOOL-20260925-01374C',
      },
    });

    assert.equal(error.message, 'An internal error occurred. Check the server log for details.');
    assert.equal(error.code, 'INTERNAL_ERROR');
    assert.equal(error.unanswered, false);
  });
});

describe('a response the API never sent', () => {
  /** Exactly what the dev proxy returns while the API is being replaced. */
  it('says the API did not respond when the body is empty', () => {
    const error = new ApiError(500, null);

    assert.match(error.message, /did not respond/);
    assert.match(error.message, /never reached the pipeline/);
    assert.equal(error.code, 'API_NOT_RESPONDING');
    assert.equal(error.unanswered, true);
  });

  it('still records the status, so the log and the UI agree', () => {
    assert.match(new ApiError(500, null).message, /HTTP 500/);
    assert.match(new ApiError(502, null).message, /HTTP 502/);
  });

  it('treats any other shape as unanswered too', () => {
    for (const body of [
      // Fastify's own default shape: `error` is a string, so there is no
      // error.message to read, and the old code silently fell through to the
      // status-only sentence.
      { statusCode: 500, error: 'Internal Server Error', message: 'boom' },
      {},
      { error: {} },
      { error: { code: 'X' } },
      'Internal Server Error',
      undefined,
    ]) {
      const error = new ApiError(500, body);
      assert.equal(error.unanswered, true, JSON.stringify(body ?? null));
      assert.match(error.message, /did not respond/);
    }
  });

  it('tells the user nothing was lost, because the request never ran', () => {
    assert.match(new ApiError(500, null).message, /Nothing was lost/);
  });
});
