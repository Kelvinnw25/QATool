import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { mergeCanonical as browserMerge } from '../../web/src/state/merge.js';
import { createEmptyCanonical, mergeCanonical } from './merge.js';

/**
 * The server's copy of what the browser does between phases must stay the browser's.
 * The backend image does not ship the web sources, so these are copies; this file is what
 * holds them equal.
 */

describe('mergeCanonical', () => {
  const current = {
    project: { project_name: 'P', project_description: null, sit_scope: ['a'] },
    documents: [{ document_id: 'DOC-001' }],
    requirements: [{ requirement_id: 'REQ-001' }],
    test_cases: [],
  };

  const partials = [
    {},
    { requirements: [{ requirement_id: 'REQ-002' }] },
    { project: { project_description: 'd' }, test_cases: [{ case_id: 'TC-001' }] },
    { project: {} },
    { documents: [], test_cases: undefined },
    { project: { project_name: 'Q', sit_scope: [] } },
  ];

  it('gives exactly what the browser’s merge gives, for every shape of partial', () => {
    for (const partial of partials) {
      assert.deepEqual(mergeCanonical(current, partial), browserMerge(current, partial));
    }
  });

  it('does not change what it was given', () => {
    const frozen = structuredClone(current);
    mergeCanonical(current, { project: { project_name: 'Z' }, requirements: [] });
    assert.deepEqual(current, frozen);
  });

  it('keeps earlier phases when a later one adds to the project', () => {
    const merged = mergeCanonical(current, { project: { qa_guidance: 'g' } });
    assert.equal(merged.project.project_name, 'P');
    assert.equal(merged.project.qa_guidance, 'g');
    assert.deepEqual(merged.requirements, current.requirements);
  });
});

describe('createEmptyCanonical', () => {
  it('has the shape the browser starts a project with', () => {
    // canonical.jsx cannot be imported (JSX), so its literal is read and its project keys compared.
    const source = readFileSync(
      new URL('../../web/src/state/canonical.jsx', import.meta.url),
      'utf8'
    );
    const literal = /export function createEmptyCanonical\(\) \{([\s\S]*?)\n\}/.exec(source)[1];
    const browserKeys = [...literal.matchAll(/^\s{6}([a-z_]+):/gm)].map((match) => match[1]);

    assert.deepEqual(Object.keys(createEmptyCanonical('X').project), browserKeys);
    assert.deepEqual(Object.keys(createEmptyCanonical('X')), [
      'project',
      'documents',
      'requirements',
      'test_cases',
    ]);
  });

  it('takes the project name and nothing else from outside', () => {
    const empty = createEmptyCanonical('My Project');
    assert.equal(empty.project.project_name, 'My Project');
    assert.deepEqual(empty.project.sit_scope, []);
    assert.deepEqual([empty.documents, empty.requirements, empty.test_cases], [[], [], []]);
  });

  it('is a new object every time, so one job cannot see another’s project', () => {
    const a = createEmptyCanonical('A');
    const b = createEmptyCanonical('B');
    a.project.sit_scope.push('x');
    a.requirements.push(1);
    assert.deepEqual(b.project.sit_scope, []);
    assert.deepEqual(b.requirements, []);
  });
});
