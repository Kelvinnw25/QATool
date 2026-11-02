/**
 * Re-runs ONLY the semantic review for a set already captured by run.js.
 *
 *   node scripts/qa-eval/review-only.js A
 *
 * The AI half of semantic validation is the one layer a provider outage hides:
 * /api/validate still answers 200 with its deterministic findings and marks
 * semantic.llm as failed, which is correct behaviour but leaves the review
 * itself unverified. This replays the stored canonical object through the
 * review alone - one provider call, no regeneration - which is exactly the
 * retry path the Results page offers.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.QA_EVAL_BASE ?? 'http://127.0.0.1:3001';
const OUT = process.env.QA_EVAL_OUT ?? join(process.cwd(), '.qa-eval-output');
const setId = (process.argv[2] ?? 'A').toUpperCase();

const records = JSON.parse(readFileSync(join(OUT, 'evaluation.json'), 'utf8'));
const record = records.find((entry) => entry.set === setId);

if (!record?.test_cases) {
  console.error(`No captured generation for set ${setId}.`);
  process.exitCode = 1;
} else {
  const canonical = {
    project: record.project,
    documents: record.documents,
    requirements: record.requirements,
    test_cases: record.test_cases,
  };

  const started = Date.now();
  const response = await fetch(`${BASE}/api/validate?semantic=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(canonical),
  });
  const validation = await response.json();

  console.log(
    `set ${setId}  ${Date.now() - started}ms  HTTP ${response.status}  ` +
      `valid=${validation.valid} rules=${validation.semantic?.heuristics} ai=${validation.semantic?.llm}`
  );
  if (validation.semantic?.error) {
    console.log(`  review error: ${JSON.stringify(validation.semantic.error)}`);
  }
  if (validation.semantic?.discarded_issues) {
    console.log(
      `  findings discarded for citing unknown ids: ${validation.semantic.discarded_issues}`
    );
  }
  console.log(
    `  model: ${validation.semantic?.model ?? '(none)'}  usage: ${JSON.stringify(validation.semantic?.usage ?? {})}`
  );

  for (const issue of validation.semantic_warnings ?? []) {
    console.log(
      `  [${issue.severity}] ${issue.category} ${issue.testcase_id ?? ''} ${issue.requirement_id ?? ''} ` +
        `(${issue.detected_by.join('+')})\n      ${issue.explanation}`
    );
  }

  // The review must never edit what it reviews.
  const unchanged = JSON.stringify(canonical.test_cases) === JSON.stringify(record.test_cases);
  console.log(`  test cases unchanged by review: ${unchanged}`);
}
