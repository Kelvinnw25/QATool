import {
  NUMERIC_LIMIT,
  REJECTION_CATEGORIES,
  REJECTION_PATH,
  statedValues,
} from '../scenario/checklist.js';
import { contentWords, similarity } from '../lib/text.js';
import { CLASSIFICATION_WARNINGS, classificationFindings } from '../schema/classification.js';

/**
 * Deterministic semantic checks.
 *
 * These catch the mistakes that have a recognisable shape - an error code the
 * requirement never mentions, an Edge case marked valid whose expected result
 * is a rejection, two cases that say the same thing - without a model call.
 * They run on every validation, cost nothing, and still stand when the LLM
 * review cannot run (no key, rate limit, provider down).
 *
 * They are signals, not verdicts. Every one of them reports and nothing else:
 * no test case is modified, reordered or removed here. Wording is bilingual
 * throughout, because the test cases are written in the requirements' own
 * language and that is usually Indonesian.
 */

// --- Outcome wording ------------------------------------------------------

/**
 * Negation is resolved before counting, because it flips the meaning of the
 * words the counts rely on: "tidak diproses" is a rejection and "tanpa error" is
 * a success. Each negated phrase becomes a marker the patterns below count.
 */
function normalizeOutcome(text) {
  return ` ${String(text ?? '').toLowerCase()} `
    .replace(
      /\b(?:tidak|not|cannot|can not|belum|never)\s+(?:ada\s+|dapat\s+|bisa\s+|be\s+|been\s+)?(?:di)?(?:proses|processed|teruskan|diteruskan|forwarded|berhasil|successful\w*|terima|diterima|accepted|sukses|succeed\w*|approved|disetujui|tercatat|recorded|completed|selesai)\w*/g,
      ' negated_acceptance '
    )
    .replace(
      /\b(?:tanpa|without|no)\s+(?:adanya\s+|any\s+)?(?:error|errors|kesalahan|failure|pesan\s+error|validation\s+error)\b/g,
      ' negated_rejection '
    );
}

/**
 * Refusal covers more than a rejected transaction. A threshold that locks an
 * account or suspends a user is refusing the operation just as firmly, and the
 * polarity of such a case decides whether it exports as Positive or Negative -
 * so the lock vocabulary belongs here with the rejection vocabulary.
 */
const REJECTION_WORDS =
  /\b(?:ditolak|tolak|menolak|reject\w*|decline\w*|gagal|fail\w*|error|kesalahan|invalid|tidak\s+valid|blocked|diblokir|dibatalkan|cancel\w*|lock(?:ed|s|out|ing)?|terkunci|dikunci|suspend\w*|ditangguhkan|negated_acceptance)\b/g;

const ACCEPTANCE_WORDS =
  /\b(?:berhasil|sukses|success\w*|diterima|accepted|diproses|processed|diteruskan|forwarded|tercatat|recorded|approved|disetujui|completed|selesai|negated_rejection)\b/g;

/**
 * Reads an expected result as a rejection, an acceptance, or neither.
 *
 * Only one-sided wording counts. "Batch ditolak dan tidak ada transaksi yang
 * diproses" mentions both, so it is 'unclear' and never flagged: a heuristic
 * that guesses at mixed wording would be wrong often enough to be ignored.
 */
export function outcomeOf(text) {
  const normalized = normalizeOutcome(text);
  const rejections = normalized.match(REJECTION_WORDS)?.length ?? 0;
  const acceptances = normalized.match(ACCEPTANCE_WORDS)?.length ?? 0;

  if (rejections > 0 && acceptances === 0) return 'rejection';
  if (acceptances > 0 && rejections === 0) return 'acceptance';
  return 'unclear';
}

/**
 * Classification values that are outside the recommended vocabulary.
 *
 * Generation attaches these to the case itself, but a canonical object arrives
 * here from the browser on every /api/validate call and may not carry that
 * history - the sample workflow has none, and a case QA edited by hand has
 * whatever they left on it. Re-deriving means validation never goes quiet about
 * a case that cannot be exported, whatever route the project took to get here.
 *
 * Mapped onto the two existing categories rather than new ones: an Edge case
 * with no polarity is a suspicious polarity, and an unrecognised case type is a
 * suspicious case type. Priority is deliberately absent - it has no semantic
 * consequence, it changes nothing about what the test means, and the export
 * gate already refuses it. A warning for every scheduling hint would train
 * reviewers to skim this list.
 */
const VOCABULARY_CATEGORIES = {
  [CLASSIFICATION_WARNINGS.UNRECOGNIZED_CASE_TYPE]: 'suspicious_case_type',
  [CLASSIFICATION_WARNINGS.EDGE_POLARITY_MISSING]: 'suspicious_edge_polarity',
  [CLASSIFICATION_WARNINGS.UNRECOGNIZED_EDGE_POLARITY]: 'suspicious_edge_polarity',
  [CLASSIFICATION_WARNINGS.EDGE_POLARITY_ON_NON_EDGE]: 'suspicious_edge_polarity',
};

function checkVocabulary(testCase) {
  return classificationFindings(testCase)
    .filter((finding) => VOCABULARY_CATEGORIES[finding.code])
    .map((finding) => ({
      severity: 'medium',
      category: VOCABULARY_CATEGORIES[finding.code],
      testcase_id: testCase.case_id,
      requirement_id: null,
      explanation: finding.message,
      detected_by: ['heuristic'],
    }));
}

function checkClassification(testCase) {
  const outcome = outcomeOf(testCase.expected_result);
  const issue = (category, explanation) => ({
    severity: 'medium',
    category,
    testcase_id: testCase.case_id,
    requirement_id: null,
    explanation,
    detected_by: ['heuristic'],
  });

  if (
    testCase.case_type === 'Edge' &&
    testCase.edge_polarity === 'valid' &&
    outcome === 'rejection'
  ) {
    return issue(
      'suspicious_edge_polarity',
      'Marked as a valid boundary, so it exports as Positive, but its Expected Result describes a rejection.'
    );
  }

  if (
    testCase.case_type === 'Edge' &&
    testCase.edge_polarity === 'invalid' &&
    outcome === 'acceptance'
  ) {
    return issue(
      'suspicious_edge_polarity',
      'Marked as an invalid boundary, so it exports as Negative, but its Expected Result describes success.'
    );
  }

  if (testCase.case_type === 'Positive' && outcome === 'rejection') {
    return issue(
      'suspicious_case_type',
      'Classified as Positive, but its Expected Result describes a rejection.'
    );
  }

  if (testCase.case_type === 'Negative' && outcome === 'acceptance') {
    return issue(
      'suspicious_case_type',
      'Classified as Negative, but its Expected Result describes success.'
    );
  }

  return null;
}

// --- Technical details the source never mentions ---------------------------

/**
 * Shapes of detail that a model invents convincingly: response and error codes,
 * identifiers, HTTP statuses, quoted UI messages. Plain numbers are left out on
 * purpose - boundary tests legitimately use values the source does not state
 * (501 for "maximum 500"), and flagging those would bury the real findings.
 */
const TECHNICAL_TOKEN_PATTERNS = [
  /\bHTTP\s?\d{3}\b/gi,
  /\b[A-Z]{1,6}[ -]?\d{2,4}\b/g, // ADMI 002, U253, E-1001
  /\b[a-z]+(?:[A-Z][a-z0-9]*)+\b/g, // camelCase: partnerServiceId
  /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, // snake_case: customer_no
  /["“]([^"”]{3,80})["”]/g, // "Saldo tidak cukup"
];

/** QATOOL's own handles look like codes; they are never inventions. */
const OWN_IDENTIFIER = /^(?:TC|REQ|DOC)[ -]?\d+$/i;

/** Comparison form: case and separators vary between a quote and a test case. */
function squash(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

export function technicalTokens(text) {
  const found = new Set();
  for (const pattern of TECHNICAL_TOKEN_PATTERNS) {
    for (const match of String(text ?? '').matchAll(pattern)) {
      const token = (match[1] ?? match[0]).trim();
      if (token && !OWN_IDENTIFIER.test(token)) found.add(token);
    }
  }
  return [...found];
}

/** Everything a test case may legitimately draw on: its cited requirements. */
function sourceCorpus(testCase, requirementsById, allRequirements) {
  const cited = testCase.requirement_ids
    .map((requirementId) => requirementsById.get(requirementId))
    .filter(Boolean);

  // An untraceable case has no specific source; checking it against the whole
  // project is the most generous reading available.
  const requirements = cited.length > 0 ? cited : allRequirements;

  return squash(
    requirements
      .flatMap((requirement) => [
        requirement.title,
        requirement.description,
        ...requirement.source_references.flatMap((reference) => [
          reference.section,
          reference.quote,
        ]),
      ])
      .join(' ')
  );
}

function checkUnsupportedDetail(testCase, requirementsById, allRequirements) {
  const corpus = sourceCorpus(testCase, requirementsById, allRequirements);
  const unsupported = (text) =>
    technicalTokens(text).filter((token) => !corpus.includes(squash(token)));

  const cited = testCase.requirement_ids.join(', ') || 'any requirement';
  const issues = [];

  const inAction = unsupported(testCase.test_case);
  if (inAction.length > 0) {
    issues.push({
      severity: 'medium',
      category: 'hallucinated_detail',
      testcase_id: testCase.case_id,
      requirement_id: null,
      explanation: `Mentions ${inAction.map((token) => `"${token}"`).join(', ')}, which does not appear in ${cited} or its source quote.`,
      detected_by: ['heuristic'],
    });
  }

  const inOutcome = unsupported(testCase.expected_result).filter(
    (token) => !inAction.includes(token)
  );
  if (inOutcome.length > 0) {
    issues.push({
      severity: 'medium',
      category: 'unsupported_implementation_detail',
      testcase_id: testCase.case_id,
      requirement_id: null,
      explanation: `Expected Result asserts ${inOutcome.map((token) => `"${token}"`).join(', ')}, which does not appear in ${cited} or its source quote.`,
      detected_by: ['heuristic'],
    });
  }

  return issues;
}

// --- Near-duplicates ---------------------------------------------------------

/**
 * Generation already removes exact and normalised repeats; what is left to
 * catch here is the same scenario with a few words moved around. The
 * tokenising and the stopword list live in lib/text.js because obligation
 * matching asks the same question of the same words.
 */

/** High enough that two genuinely different checks of one requirement survive. */
const DUPLICATE_THRESHOLD = 0.8;

/**
 * Whether the two cases differ on wording or on what they actually exercise.
 *
 * Similarity alone cannot tell those apart. Three cases covering an enumerated
 * filter - Settled, Unsettled, Settled & Unsettled - differ by a single token
 * in a twelve-word sentence, which scores 0.83 to 0.92 and was reported as two
 * duplicates on a real PRD run. The one differing word was the entire point of
 * each test.
 *
 * The discriminator is where the difference comes from. A reworded repeat
 * differs in filler and synonyms - "remains" against "stays" - which are the
 * test writer's words. A different branch differs in the requirement's OWN
 * vocabulary, because each case names a different thing the requirement says.
 *
 * So: if any word that distinguishes the two cases appears in the requirement
 * they share, they are exercising different parts of it and this is not a
 * duplicate. Erring this way costs a reviewer one extra row to read; erring
 * the other way tells QA to delete a branch nothing else covers, which is the
 * same trade-off assemble.js makes when it removes duplicates outright.
 */
function differOnRequirementContent(earlier, later, requirementsById) {
  const shared = earlier.requirement_ids.filter((id) => later.requirement_ids.includes(id));

  const vocabulary = new Set();
  for (const id of shared) {
    const requirement = requirementsById.get(id);
    if (!requirement) continue;
    for (const word of contentWords(requirement.description)) vocabulary.add(word);
  }
  if (vocabulary.size === 0) return false;

  // The action only, deliberately. Including the expected result made a case
  // whose outcome was merely stated less fully - "ditolak dan tidak diteruskan"
  // against "ditolak dan tidak diteruskan ke BI-FAST" - look like a different
  // branch, because the dropped words were the requirement's own. That is a
  // shorter sentence, not a different test. The cost is that two cases with
  // the same action and genuinely different outcomes are still reported; the
  // similarity gate above is action-only too, so this narrows nothing that gate
  // did not already decide.
  const left = contentWords(earlier.test_case);
  const right = contentWords(later.test_case);

  for (const word of left) if (!right.has(word) && vocabulary.has(word)) return true;
  for (const word of right) if (!left.has(word) && vocabulary.has(word)) return true;

  return false;
}

function checkNearDuplicates(testCases, requirementsById) {
  const issues = [];
  const words = testCases.map((testCase) => contentWords(testCase.test_case));

  for (let later = 1; later < testCases.length; later += 1) {
    for (let earlier = 0; earlier < later; earlier += 1) {
      const a = testCases[earlier];
      const b = testCases[later];

      if (a.case_type !== b.case_type || (a.edge_polarity ?? null) !== (b.edge_polarity ?? null)) {
        continue;
      }
      if (!b.requirement_ids.some((requirementId) => a.requirement_ids.includes(requirementId))) {
        continue;
      }
      if (similarity(words[earlier], words[later]) < DUPLICATE_THRESHOLD) continue;
      if (differOnRequirementContent(a, b, requirementsById)) continue;

      issues.push({
        severity: 'low',
        category: 'duplicate',
        testcase_id: b.case_id,
        requirement_id: null,
        explanation: `Very similar to ${a.case_id}: same requirement, same case type, nearly the same action.`,
        detected_by: ['heuristic'],
      });
      break; // one match is enough to report the later case
    }
  }

  return issues;
}

// --- Coverage that exists but misses the point --------------------------------

/**
 * What a requirement's wording says is worth testing - rejection paths, stated
 * limits, the values themselves - is derived by server/scenario/checklist.js,
 * which the generator also reads. Importing it rather than repeating it is the
 * point: two copies of "what counts as a bound" would eventually disagree, and
 * the disagreement would show up as a coverage warning about a bound the
 * generator was never told to test.
 */

/** At most this many untested bounds are reported per requirement. */
const MAX_REPORTED_BOUNDS = 3;

/**
 * Bounds the requirement states that no test case goes near.
 *
 * One Edge case is not coverage of a limit. A requirement reading "at least
 * IDR 10,000 and at most IDR 50,000,000" states two bounds, and a run that
 * tests only the minimum has half the coverage its Edge case implies. This is
 * deliberately literal - it asks whether the number appears anywhere in the
 * cases citing the requirement - so it reports a bound nobody wrote a value
 * for, and stays quiet once one exists.
 */
function checkUntestedBounds(requirement, citing) {
  const stated = statedValues(`${requirement.title} ${requirement.description}`);
  if (stated.size === 0) return [];

  const tested = new Set();
  for (const testCase of citing) {
    for (const value of statedValues(`${testCase.test_case} ${testCase.expected_result}`).keys()) {
      tested.add(value);
    }
  }

  const missing = [...stated].filter(([value]) => !tested.has(value));

  return missing.slice(0, MAX_REPORTED_BOUNDS).map(([, raw]) => ({
    severity: 'low',
    category: 'missing_coverage',
    testcase_id: null,
    requirement_id: requirement.requirement_id,
    explanation: `States ${raw} as a limit, but no test case citing this requirement mentions that value. The boundary may be untested even though an Edge case exists.`,
    detected_by: ['heuristic'],
  }));
}

function checkMissingCoverage(requirements, testCases) {
  const issues = [];

  for (const requirement of requirements) {
    const citing = testCases.filter((testCase) =>
      testCase.requirement_ids.includes(requirement.requirement_id)
    );

    // A requirement with no test case at all is reported by the deterministic
    // coverage check already. Saying it twice would only add noise.
    if (citing.length === 0) continue;

    const text = `${requirement.title} ${requirement.description}`;

    const needsNegative =
      REJECTION_CATEGORIES.has(requirement.category) || REJECTION_PATH.test(text);
    const hasNegative = citing.some(
      (testCase) =>
        testCase.case_type === 'Negative' ||
        (testCase.case_type === 'Edge' && testCase.edge_polarity === 'invalid')
    );

    if (needsNegative && !hasNegative) {
      issues.push({
        severity: 'medium',
        category: 'missing_coverage',
        testcase_id: null,
        requirement_id: requirement.requirement_id,
        explanation:
          'Describes a rejection or validation path, but none of its test cases is Negative or an invalid-boundary Edge case.',
        detected_by: ['heuristic'],
      });
    }

    const statesLimit = NUMERIC_LIMIT.test(text);
    const hasEdge = citing.some((testCase) => testCase.case_type === 'Edge');

    if (statesLimit && !hasEdge) {
      issues.push({
        severity: 'low',
        category: 'missing_coverage',
        testcase_id: null,
        requirement_id: requirement.requirement_id,
        explanation: 'States a numeric limit, but has no Edge case at the boundary.',
        detected_by: ['heuristic'],
      });
    }

    // An Edge case existing is not the same as every stated bound being tested.
    if (statesLimit) issues.push(...checkUntestedBounds(requirement, citing));
  }

  return issues;
}

/**
 * Runs every deterministic check.
 *
 * @param {{requirements: object[], test_cases: object[]}} canonical  structurally valid
 * @returns {object[]} issues in the semantic issue shape
 */
export function runHeuristics(canonical) {
  const requirementsById = new Map(
    canonical.requirements.map((requirement) => [requirement.requirement_id, requirement])
  );

  const issues = [];

  for (const testCase of canonical.test_cases) {
    issues.push(...checkVocabulary(testCase));

    const classification = checkClassification(testCase);
    if (classification) issues.push(classification);
    issues.push(...checkUnsupportedDetail(testCase, requirementsById, canonical.requirements));
  }

  issues.push(...checkNearDuplicates(canonical.test_cases, requirementsById));
  issues.push(...checkMissingCoverage(canonical.requirements, canonical.test_cases));

  return issues;
}
