import assert from 'node:assert/strict';
import test from 'node:test';

import { createProvider } from './provider.js';
import { config } from '../config.js';
import { generateFromRequirements } from '../generate/index.js';
import { sampleCanonicalInput } from '../generate/fixtures/sample-input.js';

/**
 * The one test that talks to the real provider.
 *
 * Opt-in and skipped by default, because `npm test` must stay free, offline and
 * deterministic - a suite that quietly spends money or fails when the wifi
 * drops is a suite people stop running.
 *
 *   QATOOL_LIVE_LLM=1 GEMINI_API_KEY=... npm run test:llm
 *
 * It sends the synthetic fixture project, never a real bank document, and
 * asserts only the structural properties the pipeline depends on. It does not
 * assert on wording: the model is allowed to be creative there, and a test that
 * pinned the prose would fail on every model update for no reason.
 */

const enabled = process.env.QATOOL_LIVE_LLM === '1';
const hasKey = Boolean(process.env.GEMINI_API_KEY);

const skip = !enabled
  ? 'Set QATOOL_LIVE_LLM=1 to run the live provider test (it makes a real, billable API call).'
  : !hasKey
    ? 'QATOOL_LIVE_LLM=1 is set but GEMINI_API_KEY is not.'
    : false;

test('the real provider returns a usable generation', { skip, timeout: 180_000 }, async () => {
  const provider = await createProvider({ ...config.llm, provider: 'gemini' });
  const result = await generateFromRequirements(sampleCanonicalInput(), { provider });

  assert.ok(result.test_cases.length > 0, 'at least one test case came back');

  for (const testCase of result.test_cases) {
    assert.match(testCase.case_id, /^TC-\d{3,}$/);
    assert.ok(testCase.expected_result.trim().length > 0);

    if (testCase.case_type === 'Edge') {
      assert.ok(['valid', 'invalid'].includes(testCase.edge_polarity));
    } else {
      assert.equal(testCase.edge_polarity, null);
    }

    // Traceability is derived, so this checks the derivation, not the model.
    for (const requirementId of testCase.requirement_ids) {
      assert.match(requirementId, /^REQ-\d{3,}$/);
    }
    for (const reference of testCase.source_references) {
      assert.ok(['DOC-001', 'DOC-002'].includes(reference.document_id));
    }
  }

  assert.ok(result.project.project_description, 'a project description came back');
  assert.ok(
    result.project.sit_scope.length >= 3 && result.project.sit_scope.length <= 5,
    `sit_scope had ${result.project.sit_scope.length} points, expected 3-5`
  );

  console.log(
    `\nlive: ${result.metadata.model} -> ${result.test_cases.length} cases, ` +
      `${result.warnings.length} warnings, ${result.metadata.duration_ms}ms, ` +
      `${result.metadata.usage.total_tokens ?? '?'} tokens\n`
  );
});
