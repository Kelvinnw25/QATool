import test from 'node:test';
import assert from 'node:assert/strict';
import { projectSchema } from './project.js';
import { hasMultipleSentences } from './common.js';

function validProject(overrides = {}) {
  return {
    project_name: 'Bulk Credit Transfer Phase 2',
    project_description: 'Enables bulk credit transfer routing between participating banks.',
    project_summary: null,
    qa_guidance: null,
    project_background: null,
    sit_scope: [],
    ...overrides,
  };
}

test('accepts a one-sentence project description', () => {
  const result = projectSchema.safeParse(validProject());
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test('rejects a project description of more than one sentence', () => {
  // The instruction is "exactly one concise sentence", and an LLM overruns that
  // reliably enough to be worth checking rather than hoping for.
  const result = projectSchema.safeParse(
    validProject({
      project_description:
        'Enables bulk credit transfer routing. It also updates the participant status table.',
    })
  );
  assert.equal(result.success, false);
  assert.deepEqual(
    result.error.issues.map((issue) => issue.path.join('.')),
    ['project_description']
  );
});

test('a trailing full stop is not a second sentence', () => {
  assert.equal(hasMultipleSentences('One sentence only.'), false);
  assert.equal(hasMultipleSentences('One sentence only'), false);
  assert.equal(hasMultipleSentences('Does this count as one?'), false);
});

test('abbreviations and decimals do not read as sentence breaks', () => {
  // Bank documents are full of these; treating their full stop as a break
  // would reject perfectly good one-liners.
  for (const text of [
    'Adds PT. Dian Ciptamas Agung as a PayrollQ SFTP client.',
    'Validates mandatory fields e.g. BIC code and account number.',
    'Rejects transfers above the 1.5 billion IDR ceiling.',
    'Covers the routing rules i.e. Active versus Suspended participants.',
    'Reviewed by J. Smith before release.',
  ]) {
    assert.equal(hasMultipleSentences(text), false, `should be one sentence: ${text}`);
  }
});

test('genuine sentence breaks are detected', () => {
  for (const text of [
    'Adds a new client. Updates the routing table.',
    'Is the batch accepted? The limit is 50 transactions.',
    'Rejects the transfer! Logs the reason code.',
  ]) {
    assert.equal(hasMultipleSentences(text), true, `should be multiple: ${text}`);
  }
});

test('project description is optional and empty normalises to null', () => {
  const withoutDescription = projectSchema.safeParse(
    validProject({ project_description: undefined })
  );
  assert.ok(withoutDescription.success, JSON.stringify(withoutDescription.error?.issues));
  assert.equal(withoutDescription.data.project_description, null);

  const empty = projectSchema.safeParse(validProject({ project_description: '   ' }));
  assert.ok(empty.success);
  assert.equal(empty.data.project_description, null);
});

test('project description is length bounded', () => {
  const result = projectSchema.safeParse(
    validProject({ project_description: `${'x'.repeat(301)}` })
  );
  assert.equal(result.success, false);
});

test('project description accepts exactly 300 characters and rejects 301', () => {
  const at = projectSchema.safeParse(validProject({ project_description: 'x'.repeat(300) }));
  assert.equal(at.success, true);
  assert.equal(at.data.project_description.length, 300);
  assert.equal(
    projectSchema.safeParse(validProject({ project_description: 'x'.repeat(301) })).success,
    false
  );
});

test('the project carries the five generated outputs and nothing else', () => {
  assert.deepEqual(Object.keys(projectSchema.shape).sort(), [
    'project_background',
    'project_description',
    'project_name',
    'project_summary',
    'qa_guidance',
    'sit_scope',
  ]);
});
