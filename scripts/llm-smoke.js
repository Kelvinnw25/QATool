/**
 * Manual smoke test against the configured LLM provider.
 *
 *   node --env-file-if-exists=.env scripts/llm-smoke.js
 *
 * Makes one real, billable API call with the synthetic fixture project and
 * prints what came back, so a key, a model name or a prompt change can be
 * checked without going through the browser. Nothing is written to disk: it
 * prints and exits, like every other part of QATOOL.
 *
 * Confidential documents have no business here - the input is the same
 * invented BI-FAST fixture the automated tests use.
 */
import { config } from '../server/config.js';
import { createProvider } from '../server/llm/provider.js';
import { generateFromRequirements } from '../server/generate/index.js';
import { sampleCanonicalInput } from '../server/generate/fixtures/sample-input.js';

function line(text = '') {
  process.stdout.write(`${text}\n`);
}

/**
 * Failures set process.exitCode and let the event loop drain rather than
 * calling process.exit(). On Windows, exiting while fetch's keep-alive socket
 * is still closing trips a libuv assertion and crashes the process.
 */
function fail(error) {
  line(`  FAILED  ${error.code ?? 'ERROR'}: ${error.message}`);
  for (const detail of error.details ?? []) {
    line(`          ${detail.path ?? detail.code ?? ''} ${detail.message ?? ''}`.trimEnd());
  }
  line();
  process.exitCode = 1;
}

function report({ project, test_cases: testCases, warnings, metadata }) {
  line(`${metadata.test_case_count} test cases in ${metadata.duration_ms} ms`);
  line(
    `tokens: ${metadata.usage.input_tokens ?? '?'} in / ${metadata.usage.output_tokens ?? '?'} out` +
      ` / ${metadata.usage.thinking_tokens ?? 0} thinking`
  );
  line(
    `covered ${metadata.requirements_covered}/${metadata.requirement_count} requirements, ` +
      `${metadata.duplicates_removed} duplicate(s) removed`
  );

  line('\n--- Project Description ---');
  line(project.project_description);
  line('\n--- Project Summary ---');
  line(project.project_summary);
  line('\n--- QA Guidance ---');
  line(project.qa_guidance);
  line('\n--- SIT Scope ---');
  for (const point of project.sit_scope) line(`- ${point}`);
  line('\n--- Project Background ---');
  line(project.project_background);

  line('\n--- Test cases ---');
  for (const testCase of testCases) {
    const polarity = testCase.edge_polarity ? `/${testCase.edge_polarity}` : '';
    const trace = testCase.source_references
      .map((reference) => `${reference.document_id}${reference.page ? ` p${reference.page}` : ''}`)
      .join(', ');

    line(
      `\n${testCase.case_id} [${testCase.case_type}${polarity}] ${testCase.priority} ` +
        `confidence=${testCase.confidence} <- ${testCase.requirement_ids.join(', ') || '(none)'}`
    );
    line(`  ${testCase.test_case}`);
    line(`  => ${testCase.expected_result}`);
    line(`  source: ${trace || '(none)'}`);
    for (const warning of testCase.warnings) line(`  ! ${warning.code}: ${warning.message}`);
  }

  if (warnings.length > 0) {
    line('\n--- Generation warnings ---');
    for (const warning of warnings) {
      line(`  ${warning.code}${warning.requirement_id ? ` (${warning.requirement_id})` : ''}`);
      line(`    ${warning.message}`);
    }
  }

  line();
}

async function main() {
  let provider;
  try {
    provider = await createProvider();
  } catch (error) {
    fail(error);
    return;
  }

  line(`\nProvider : ${provider.name}`);
  line(`Model    : ${provider.model}`);
  line(`Timeout  : ${config.llm.timeoutMs} ms`);
  line('\nGenerating from the synthetic fixture project...\n');

  try {
    report(await generateFromRequirements(sampleCanonicalInput(), { provider }));
  } catch (error) {
    fail(error);
  }
}

await main();
