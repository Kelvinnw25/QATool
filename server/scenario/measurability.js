import { statedValues } from './checklist.js';

/**
 * Whether an obligation can be tested at all.
 *
 * Coverage reporting has two honest answers for an obligation no test case
 * reaches: "QA missed it" and "the source never said enough to test it". Until
 * now both were reported the same way, which made the first invisible inside
 * the second - a document full of "the report loads quickly" produced a pile of
 * permanent gaps, and a genuine miss sat in that pile unnoticed.
 *
 * So this splits them, deterministically, and the split is deliberately
 * lopsided. Marking an obligation not measurable EXCUSES it from coverage, so a
 * false positive here is precisely the silent loss this module exists to
 * prevent. Every rule therefore demands positive evidence of vagueness, and
 * anything carrying a value, code, status or limit is measurable whatever
 * adjectives sit beside it.
 */

export const MEASURABILITY_REASONS = {
  UNQUANTIFIED_QUALITY: 'not_measurable_unquantified_quality',
  IMPLEMENTATION_INSTRUCTION: 'not_measurable_implementation_instruction',
};

/**
 * Verbs addressed to whoever builds the system, not to the system.
 *
 * Read strictly from how the real PRD words its own bullets. Under one THEN it
 * lists five, and four describe what the software does at run time - "Extract
 * all transaction data from 00.00 to 23.59", "Ensure the process runs
 * automatically", "Use SETTLEMENT_QRMANAGER_DDMMYYYY.txt as file name format",
 * "Save the final .txt file into a designated directory path". The fifth is
 *
 *   "Create and implement new automated scheduler to trigger the daily report
 *    generation"
 *
 * which instructs a developer to build a component. Its observable consequence
 * is already stated elsewhere in the same requirement - the WHEN fires at 03.00
 * AM and the four siblings say what then happens - so there is nothing left for
 * a test to confirm that those do not already confirm.
 *
 * Only "implement" and "develop" are here. "Create" alone is NOT: software
 * creates files, records and columns at run time, and excluding it would drop
 * real behaviour. A build instruction that also states a value is measurable
 * anyway - the value check above runs first and wins.
 */
const BUILD_INSTRUCTION =
  /\b(?:implement(?:s|ed|ing|ation)?|develop(?:s|ed|ing|ment)?|mengimplementasikan|implementasi|kembangkan|mengembangkan)\b/i;

/**
 * Words that describe a magnitude without stating one.
 *
 * Only words whose whole content is a judgement. "Immediately" and "segera" are
 * absent on purpose: they usually qualify a real, observable action rather than
 * standing in for a threshold, and excusing every sentence containing them
 * would hide far more than it explained.
 */
const UNQUANTIFIED_QUALITY =
  /\b(?:quickly|quick|fast(?:er)?|rapidly|speedily|efficiently|smoothly|seamlessly|user[- ]friendly|intuitive|optimal(?:ly)?|reasonabl[ey]|adequate(?:ly)?|sufficiently|appropriately|as\s+soon\s+as\s+possible|in\s+a\s+timely\s+manner|without\s+delay|properly|correctly|as\s+expected|as\s+designed|cepat|lancar|mudah|wajar|memadai|optimal|sesuai\s+kebutuhan|dengan\s+benar|sebagaimana\s+mestinya)\b/i;

/**
 * Classifies one obligation.
 *
 * Judged on the source's own words, never on the derived statement alone: the
 * statement is our phrasing and could introduce a word the document never used.
 *
 * @param {object} obligation  from deriveCoverageObligations
 * @returns {{measurable: boolean, reason: string|null}}
 */
export function classifyMeasurability(obligation) {
  const basis = obligation?.source_basis ?? '';

  // A stated number is a threshold a tester can check, and it settles the
  // question before any adjective is read.
  if (statedValues(basis).size > 0) return { measurable: true, reason: null };

  if (BUILD_INSTRUCTION.test(basis)) {
    return { measurable: false, reason: MEASURABILITY_REASONS.IMPLEMENTATION_INSTRUCTION };
  }

  if (UNQUANTIFIED_QUALITY.test(basis)) {
    return { measurable: false, reason: MEASURABILITY_REASONS.UNQUANTIFIED_QUALITY };
  }

  return { measurable: true, reason: null };
}

/**
 * Adds the verdict to each obligation in a matched coverage list.
 *
 * @param {object[]} matched  from matchObligations
 */
export function withMeasurability(matched) {
  return (matched ?? []).map((obligation) => ({
    ...obligation,
    ...classifyMeasurability(obligation),
  }));
}
