/**
 * Text primitives shared by the modules that compare wording.
 *
 * Extracted from server/semantic/heuristics.js when a second consumer appeared:
 * obligation matching asks "does this test case mention this clause?", which is
 * the same tokenising question near-duplicate detection asks. Two copies of a
 * stopword list would drift, and the drift would show up as a coverage claim
 * one module makes and the other denies.
 *
 * Bilingual throughout, because the test cases are written in the requirements'
 * own language and that is usually Indonesian.
 */

/**
 * Words that carry no behaviour, so two sentences differing only in these are
 * the same sentence for comparison purposes.
 */
const STOPWORDS = new Set(
  (
    'a an the of to for with and or in on at by is are be that this when if then ' +
    'verify verifikasi pastikan memastikan uji test check cek ' +
    'yang dan atau untuk dengan ke di dari pada saat ketika jika maka bahwa ini itu ' +
    'akan sudah oleh sebagai secara agar dapat'
  ).split(' ')
);

/**
 * Folds an English plural, so a rephrasing is not read as a different behaviour.
 *
 * Measured cost of not doing it: the obligation "display all of the settled
 * transaction" against a test case reading "displays all settled transactions"
 * shared exactly one word of four and was reported as uncovered. Two of the six
 * gaps on a real PRD were this - a coverage report claiming a tested branch was
 * untested, which is the most expensive kind of wrong.
 *
 * Applied to both sides of every comparison, so words it mangles - status to
 * statu, process to proces - still match each other. Indonesian does not
 * pluralise with -s, so the bilingual case is unaffected.
 */
const singular = (word) => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word);

/** The meaning-bearing words of a phrase, in order and with repeats kept. */
function contentSequence(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word))
    .map(singular);
}

/** The meaning-bearing words of a phrase, lowercased and deduplicated. */
export function contentWords(text) {
  return new Set(contentSequence(text));
}

/**
 * How many consecutive words in order count as quoting rather than coinciding.
 *
 * Five is high enough that it cannot happen by accident - stopwords are already
 * gone, so five consecutive content words in the same order is a phrase lifted
 * from the source, not two sentences about the same subject.
 */
const QUOTED_RUN = 5;

/**
 * Whether a text quotes a contiguous stretch of a phrase.
 *
 * A SUFFICIENT condition beside mentions(), never a replacement for it: nothing
 * that failed before now passes unless it contains the source's own words in
 * the source's own order, so no unrelated comparison gets looser.
 *
 * It exists because the ratio test has one blind spot, and a real test case fell
 * into it. The obligation "Ensure the process runs automatically without normal
 * intervention and without creating temporary files (.tmp) during extraction"
 * was matched against a case containing that operative phrase VERBATIM, and
 * scored 7 of the 13 words it needed 8 of - because the six it missed were the
 * obligation's own framing ("Ensure the process runs ... during extraction"),
 * which no test case would ever repeat. Lowering the ratio to admit it would
 * have loosened every other comparison; requiring a quotation admits it and
 * nothing else.
 */
export function quotes(text, phrase) {
  const needle = contentSequence(phrase);
  if (needle.length < QUOTED_RUN) return false;

  const haystack = ` ${contentSequence(text).join(' ')} `;

  for (let start = 0; start + QUOTED_RUN <= needle.length; start += 1) {
    if (haystack.includes(` ${needle.slice(start, start + QUOTED_RUN).join(' ')} `)) return true;
  }

  return false;
}

/** Jaccard similarity over content words: shared / union. */
export function similarity(left, right) {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/**
 * How much of a clause must be present before a text counts as mentioning it.
 *
 * Containment with tolerance, not similarity: a test case is far longer than
 * the clause it exercises, so Jaccard scores near zero on a genuine match and
 * is the wrong tool. What matters is that the clause's own words are there.
 *
 * The tolerance exists because a test case rephrases rather than quotes -
 * "retry Release Settlement" becomes "the Release Settlement call is retried" -
 * and demanding every word would report almost everything as untested. Two
 * words must always match, so a clause cannot be "mentioned" by a single
 * incidental word.
 */
const MENTION_RATIO = 0.6;
const MENTION_FLOOR = 2;

/**
 * Whether `haystack` contains enough of `phrase` to count as mentioning it.
 *
 * Deliberately biased towards "no". An unmatched clause is reported as an
 * uncovered obligation, which the semantic reviewer then judges; a wrongly
 * matched one silently claims coverage nobody checked, and claiming coverage
 * that does not exist is the failure this whole layer was added to prevent.
 *
 * @param {Set<string>} haystack  content words of the text being searched
 * @param {string} phrase         the clause being looked for
 * @returns {boolean} false whenever the clause is too thin to judge
 */
export function mentions(haystack, phrase) {
  const words = [...contentWords(phrase)];
  if (words.length < MENTION_FLOOR) return false;

  const needed = Math.max(MENTION_FLOOR, Math.ceil(words.length * MENTION_RATIO));
  let found = 0;
  for (const word of words) if (haystack.has(word)) found += 1;

  return found >= needed;
}

/**
 * How far the words of one clause may spread and still be one statement.
 *
 * A multiple of the clause's own length, not a fixed count, because a long
 * clause legitimately takes more room to restate than a short one. Two is the
 * most generous multiple that still separates the case this was added for, and
 * generous is the right side to err on: the window exists to reject words
 * gathered from opposite ends of a paragraph, not to demand a quotation.
 */
const LOCALITY_MULTIPLE = 2;

/**
 * Whether a text states a clause in ONE PLACE, rather than merely containing
 * its words somewhere.
 *
 * Same ratio and same floor as mentions(), plus one constraint: the words must
 * sit within a window twice the clause's own length. It is therefore strictly
 * narrower than mentions() - nothing passes here that failed there.
 *
 * It exists because a bag of words cannot tell a clause from its vocabulary,
 * and a real guard fell into that gap. The obligation
 *
 *   "retry is only performed when the status check response is FAILED
 *    (transaction not completed) and the retry attempt has not reached 3 times"
 *
 * was reported COVERED by a test case that never stated the restriction. The
 * case said a retry happens on FAILED or NOT FOUND, up to 3 times - and that
 * sentence supplies "status", "response", "failed", "retry", "attempt", "not",
 * "times" and "performed" on its own. Eight of the thirteen words, exactly the
 * eight needed, every one of them generic retry vocabulary; the words that made
 * it a guard - "only", "has", "reached" - were the ones missing. The report
 * could not have said otherwise, whatever the model wrote.
 *
 * Scattered across a paragraph those eight words score 7 in any one window and
 * the guard is correctly reported uncovered. Stated as the source states it -
 * "and the retry attempt has not reached 3 times, a retry is triggered" - they
 * score 11. The separation is the locality, not the vocabulary.
 */
export function mentionsLocally(text, phrase) {
  const needle = [...contentWords(phrase)];
  if (needle.length < MENTION_FLOOR) return false;

  const needed = Math.max(MENTION_FLOOR, Math.ceil(needle.length * MENTION_RATIO));
  const haystack = contentSequence(text);
  const span = Math.max(needle.length * LOCALITY_MULTIPLE, needed);

  for (let start = 0; start === 0 || start + needed <= haystack.length; start += 1) {
    const window = new Set(haystack.slice(start, start + span));
    let found = 0;
    for (const word of needle) if (window.has(word)) found += 1;
    if (found >= needed) return true;
  }

  return false;
}
