import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PHASE_KEYS, runPipeline } from './pipeline.js';
import { mergeCanonical } from './state/merge.js';

/**
 * The pipeline runner, and the bug it exists to make impossible.
 *
 * Each phase's output used to reach the next phase only through React state,
 * and React does not render a state update made in an async continuation until
 * the current task ends - after the next phase had already posted. Generation
 * received no requirements, and validation received no test cases and reported
 * every requirement uncovered. None of the existing tests saw it, because none
 * of them ran the phases in sequence.
 *
 * The decisive cases below commit nothing until a later task, exactly as React
 * does, and still expect every phase to post the previous phase's output.
 */

/** The shape createEmptyCanonical() returns; that module is JSX, so not importable here. */
const emptyCanonical = () => ({
  project: {
    project_name: '',
    project_description: null,
    project_summary: null,
    qa_guidance: null,
    project_background: null,
    sit_scope: [],
  },
  documents: [],
  requirements: [],
  test_cases: [],
});

const requirement = (id) => ({ requirement_id: id, title: id });
const testCase = (id, requirementId) => ({ case_id: id, requirement_ids: [requirementId] });

/** An api double that records what each phase posted. */
function recordingApi({ failOn = null } = {}) {
  const posted = { extract: [], generate: [], validate: [] };

  return {
    posted,
    api: {
      async extract(files) {
        posted.extract.push(files);
        if (failOn === 'extract') throw Object.assign(new Error('extract failed'), { code: 'X' });
        return {
          documents: [{ document_id: 'DOC-001' }],
          requirements: [requirement('REQ-001'), requirement('REQ-002')],
          test_points: [{ requirement_id: 'REQ-001', point: 'boundary' }],
        };
      },
      async generate(canonical, testPoints) {
        posted.generate.push({ canonical, testPoints });
        if (failOn === 'generate') {
          throw Object.assign(new Error('Gemini did not respond'), { code: 'LLM_TIMEOUT' });
        }
        return {
          project: { project_name: 'Settlement Report' },
          test_cases: [testCase('TC-001', 'REQ-001'), testCase('TC-002', 'REQ-002')],
          warnings: [],
          metadata: {},
        };
      },
      async validate(canonical, options) {
        posted.validate.push({ canonical, options });
        return { valid: true };
      },
    },
  };
}

/**
 * Commits nothing synchronously - every merge lands in a later task, as a React
 * state update from an async continuation does.
 */
function deferredStore(initial) {
  const store = { committed: initial };
  const later = (apply) => setTimeout(apply, 0);
  const commit = (_result, partial) =>
    later(() => {
      store.committed = mergeCanonical(store.committed, partial);
    });
  store.on = { extracted: commit, generated: commit };
  return store;
}

describe('runPipeline threads the project between phases', () => {
  it('posts the extracted requirements to generation, even when nothing has committed yet', async () => {
    const { api, posted } = recordingApi();
    const store = deferredStore(emptyCanonical());

    await runPipeline({ canonical: store.committed, files: ['spec.pdf'], api, on: store.on });

    const sent = posted.generate[0].canonical.requirements.map((r) => r.requirement_id);
    assert.deepEqual(sent, ['REQ-001', 'REQ-002'], 'generation was refused for this before');
  });

  it('posts the generated test cases to validation, even when nothing has committed yet', async () => {
    const { api, posted } = recordingApi();
    const store = deferredStore(emptyCanonical());

    await runPipeline({ canonical: store.committed, files: [], api, on: store.on });

    const sent = posted.validate[0].canonical.test_cases.map((t) => t.case_id);
    assert.deepEqual(sent, ['TC-001', 'TC-002'], 'every requirement read as uncovered before');
    assert.equal(posted.validate[0].canonical.requirements.length, 2);
  });

  it('ends with the committed project equal to the one validation saw', async () => {
    const { api, posted } = recordingApi();
    const store = deferredStore(emptyCanonical());

    await runPipeline({ canonical: store.committed, files: [], api, on: store.on });
    await new Promise((resolve) => setTimeout(resolve, 5));

    assert.deepEqual(posted.validate[0].canonical, store.committed);
  });

  it('carries the extraction test points to generation and validation', async () => {
    const { api, posted } = recordingApi();

    await runPipeline({ canonical: emptyCanonical(), files: [], api });

    assert.equal(posted.generate[0].testPoints.length, 1);
    assert.equal(posted.validate[0].options.testPoints.length, 1);
    assert.equal(posted.validate[0].options.semantic, true);
  });

  it('merges project outputs without dropping what extraction added', async () => {
    const { api, posted } = recordingApi();

    await runPipeline({ canonical: emptyCanonical(), files: [], api });

    const sent = posted.validate[0].canonical;
    assert.equal(sent.project.project_name, 'Settlement Report');
    assert.deepEqual(sent.project.sit_scope, [], 'fields generation did not return are kept');
    assert.equal(sent.documents.length, 1);
  });
});

describe('runPipeline on failure and retry', () => {
  it('stops at the failed phase, reports it, and runs nothing after it', async () => {
    const { api, posted } = recordingApi({ failOn: 'generate' });
    const failures = [];

    const outcome = await runPipeline({
      canonical: emptyCanonical(),
      files: [],
      api,
      on: { failed: (phase, cause) => failures.push({ phase, code: cause.code }) },
    });

    assert.equal(outcome.completed, false);
    assert.deepEqual(failures, [{ phase: 'generate', code: 'LLM_TIMEOUT' }]);
    assert.equal(posted.validate.length, 0);
  });

  it("keeps the earlier phase's work when a later one fails", async () => {
    const { api } = recordingApi({ failOn: 'generate' });

    const outcome = await runPipeline({ canonical: emptyCanonical(), files: [], api });

    assert.equal(outcome.canonical.requirements.length, 2, 'extraction is not lost');
  });

  it('resumes from the failed phase with the project it is given, and does not re-extract', async () => {
    const { api, posted } = recordingApi();
    const extracted = mergeCanonical(emptyCanonical(), { requirements: [requirement('REQ-007')] });

    await runPipeline({ from: 'generate', canonical: extracted, testPoints: [{}], api });

    assert.equal(posted.extract.length, 0);
    assert.deepEqual(
      posted.generate[0].canonical.requirements.map((r) => r.requirement_id),
      ['REQ-007']
    );
    assert.equal(posted.generate[0].testPoints.length, 1, 'held test points survive a retry');
  });

  it('treats a callback that throws as a failure of that phase', async () => {
    const { api, posted } = recordingApi();
    const failures = [];

    await runPipeline({
      canonical: emptyCanonical(),
      files: [],
      api,
      on: {
        extracted: () => {
          throw new Error('render failed');
        },
        failed: (phase) => failures.push(phase),
      },
    });

    assert.deepEqual(failures, ['extract']);
    assert.equal(posted.generate.length, 0);
  });

  it('reports each phase as started and completed, in order', async () => {
    const { api } = recordingApi();
    const seen = [];

    await runPipeline({
      canonical: emptyCanonical(),
      files: [],
      api,
      on: {
        started: (phase) => seen.push(`start:${phase}`),
        completed: (phase) => seen.push(`done:${phase}`),
      },
    });

    assert.deepEqual(
      seen,
      PHASE_KEYS.flatMap((phase) => [`start:${phase}`, `done:${phase}`])
    );
  });

  it('refuses a phase it does not know', async () => {
    const { api } = recordingApi();

    await assert.rejects(
      () => runPipeline({ from: 'export', canonical: emptyCanonical(), api }),
      /Unknown pipeline phase/
    );
  });
});

describe('mergeCanonical', () => {
  it('keeps earlier phases and merges project fields rather than replacing them', () => {
    const merged = mergeCanonical(
      { ...emptyCanonical(), requirements: [requirement('REQ-001')] },
      { project: { project_name: 'X' }, test_cases: [testCase('TC-001', 'REQ-001')] }
    );

    assert.equal(merged.requirements.length, 1);
    assert.equal(merged.test_cases.length, 1);
    assert.equal(merged.project.project_name, 'X');
    assert.deepEqual(merged.project.sit_scope, []);
  });

  it('does not change the project it was given', () => {
    const before = emptyCanonical();
    mergeCanonical(before, { requirements: [requirement('REQ-001')] });

    assert.equal(before.requirements.length, 0);
  });
});
