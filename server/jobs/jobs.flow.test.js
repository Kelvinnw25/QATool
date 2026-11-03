import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { startDemo, uploadForm, waitForState } from './fixtures/demo.js';

/**
 * The happy path through the real HTTP surface: a session, a document, a job that runs
 * the three phases, and the results. The model is a fake; the Turnstile check is a fake.
 */

const demos = [];
afterEach(async () => {
  await Promise.all(demos.splice(0).map((demo) => demo.close()));
});

async function demo(options) {
  const started = await startDemo(options);
  demos.push(started);
  return started;
}

describe('a visitor runs a workflow', () => {
  it('mints a ticket, submits documents, polls, and reads every phase', async () => {
    const d = await demo();
    const v = await d.visitor();

    const submitted = await d.call('POST', '/api/jobs', { ticket: v.ticket, form: uploadForm() });
    assert.equal(submitted.status, 202, JSON.stringify(submitted.body));
    assert.match(submitted.body.job.id, /^j_[A-Za-z0-9_-]{22}$/);
    assert.equal(submitted.headers.get('location'), `/api/jobs/${submitted.body.job.id}`);
    assert.equal(submitted.body.job.from, 'extract');
    assert.match(submitted.body.job.boot_id, /^b_/);

    const done = await waitForState(d, v, submitted.body.job.id, ['completed', 'failed']);
    assert.equal(done.state, 'completed', JSON.stringify(done.error));
    assert.deepEqual(done.phases, { extract: 'done', generate: 'done', validate: 'done' });

    const result = await d.call('GET', `/api/jobs/${done.id}/result`, { ticket: v.ticket });
    assert.equal(result.status, 200);
    const { extract, generate, validate } = result.body.phases;
    assert.ok(extract.requirements.length > 0);
    assert.ok(generate.test_cases.length > 0);
    assert.equal(typeof validate.valid, 'boolean');
  });
});
