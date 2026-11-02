import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runPipeline } from './pipeline.js';

/**
 * One run, one model. These tests hold the runner to it: the provider it is
 * given reaches extract, generate AND validate unchanged, a retry passes the
 * same value again, and a run that has been replaced stops without touching
 * anything.
 */

const emptyCanonical = () => ({
  project: { project_name: 'P' },
  documents: [],
  requirements: [],
  test_cases: [],
});

/** An api double that records the provider each call was given. */
function recordingApi({ failOn = null, onCall = () => {} } = {}) {
  const seen = [];
  const record = (phase, options) => {
    seen.push({ phase, provider: options?.provider });
    onCall(phase);
  };

  return {
    seen,
    api: {
      async extract(files, options) {
        record('extract', options);
        if (failOn === 'extract') throw Object.assign(new Error('boom'), { code: 'X' });
        return { documents: [{ document_id: 'DOC-001' }], requirements: [], test_points: [] };
      },
      async generate(canonical, testPoints, options) {
        record('generate', options);
        if (failOn === 'generate') {
          throw Object.assign(new Error('Claude via Apayee is not available'), {
            code: 'PROVIDER_UNAVAILABLE',
          });
        }
        return { project: { project_name: 'P' }, test_cases: [] };
      },
      async validate(canonical, options) {
        record('validate', options);
        return { valid: true };
      },
    },
  };
}

const run = (extra) => ({ canonical: emptyCanonical(), files: [], ...extra });

describe('the run’s model reaches every phase', () => {
  it('passes the same provider to extract, generate and validate', async () => {
    const { api, seen } = recordingApi();

    const result = await runPipeline(run({ api, provider: 'claude' }));

    assert.equal(result.completed, true);
    assert.deepEqual(seen, [
      { phase: 'extract', provider: 'claude' },
      { phase: 'generate', provider: 'claude' },
      { phase: 'validate', provider: 'claude' },
    ]);
  });

  it('does the same for Gemini', async () => {
    const { api, seen } = recordingApi();
    await runPipeline(run({ api, provider: 'gemini' }));
    assert.deepEqual(
      seen.map((call) => call.provider),
      ['gemini', 'gemini', 'gemini']
    );
  });

  it('passes null - leave it to the server - to every phase when no model was chosen', async () => {
    const { api, seen } = recordingApi();
    await runPipeline(run({ api }));
    assert.deepEqual(
      seen.map((call) => call.provider),
      [null, null, null]
    );
  });

  it('keeps the semantic review on the model the run began with', async () => {
    let validateOptions;
    const { api } = recordingApi();
    api.validate = async (canonical, options) => {
      validateOptions = options;
      return {};
    };

    await runPipeline(run({ api, provider: 'claude' }));

    assert.equal(validateOptions.semantic, true);
    assert.equal(validateOptions.provider, 'claude');
  });
});

describe('retrying', () => {
  it('resumes at the failed phase with the same model', async () => {
    const first = recordingApi({ failOn: 'generate' });
    const failed = await runPipeline(run({ api: first.api, provider: 'claude' }));

    assert.equal(failed.completed, false);
    assert.equal(failed.superseded, false);

    const retry = recordingApi();
    const resumed = await runPipeline(
      run({ api: retry.api, provider: 'claude', from: 'generate', canonical: failed.canonical })
    );

    assert.equal(resumed.completed, true);
    assert.deepEqual(retry.seen, [
      { phase: 'generate', provider: 'claude' },
      { phase: 'validate', provider: 'claude' },
    ]);
  });

  it('surfaces an unavailable provider as a failure of the phase, with the server’s code', async () => {
    const { api } = recordingApi({ failOn: 'generate' });
    const failures = [];

    await runPipeline(
      run({
        api,
        provider: 'claude',
        on: { failed: (phase, cause) => failures.push({ phase, code: cause.code }) },
      })
    );

    assert.deepEqual(failures, [{ phase: 'generate', code: 'PROVIDER_UNAVAILABLE' }]);
  });
});

describe('a run that has been replaced', () => {
  it('does not start at all', async () => {
    const { api, seen } = recordingApi();

    const result = await runPipeline(run({ api, provider: 'claude', isCurrent: () => false }));

    assert.equal(result.superseded, true);
    assert.deepEqual(seen, []);
  });

  it('stops after the response in flight, without reporting it or calling again', async () => {
    let current = true;
    const events = [];
    const { api, seen } = recordingApi({
      // The replacement happens while the extract response is on its way back.
      onCall: (phase) => {
        if (phase === 'extract') current = false;
      },
    });

    const result = await runPipeline(
      run({
        api,
        provider: 'gemini',
        isCurrent: () => current,
        on: {
          started: (phase) => events.push(`started:${phase}`),
          extracted: () => events.push('extracted'),
          completed: (phase) => events.push(`completed:${phase}`),
          failed: () => events.push('failed'),
        },
      })
    );

    assert.equal(result.superseded, true);
    assert.equal(result.completed, false);
    assert.deepEqual(events, ['started:extract'], 'the stale answer was not handed over');
    assert.deepEqual(
      seen.map((call) => call.phase),
      ['extract']
    );
  });

  it('does not report a stale failure either', async () => {
    let current = true;
    const failures = [];
    const { api } = recordingApi({
      failOn: 'extract',
      onCall: () => {
        current = false;
      },
    });

    const result = await runPipeline(
      run({
        api,
        isCurrent: () => current,
        on: { failed: (phase) => failures.push(phase) },
      })
    );

    assert.equal(result.superseded, true);
    assert.deepEqual(failures, []);
  });

  it('lets a run that is still current finish normally', async () => {
    const { api } = recordingApi();
    const result = await runPipeline(run({ api, provider: 'claude', isCurrent: () => true }));

    assert.equal(result.completed, true);
    assert.equal(result.superseded, false);
  });
});
