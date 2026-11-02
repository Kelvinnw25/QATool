import { contentWords, similarity } from '../lib/text.js';

/**
 * Test case diagnostics: the shape of a drafted case, read without a model.
 *
 * Three problems a reviewer should see before a case reaches SIT. Each was
 * found by a manual audit of ten generation runs over two real PRDs, and each
 * is invisible to every other check, because coverage asks whether a behaviour
 * is mentioned, not whether the case can be executed and judged:
 *
 *   non-atomic         one case carries several independent branches,
 *                      triggers or outcomes. A tester executes one of them and
 *                      the case still reads as passed for all.
 *   vague criteria     "quickly", "all data states". An Expected Result that no
 *                      observation can fail.
 *   intermediate-only  the case asserts that the system moved on ("proceeds to
 *                      the next validation") and stops, where the source goes
 *                      on to say what must happen next.
 *
 * DIAGNOSTICS ONLY. Nothing here modifies, removes, reorders or counts a test
 * case; nothing feeds coverage, obligation matching, generation or export; and
 * nothing blocks anything. The result travels in the /api/validate response
 * under its own key rather than among the semantic warnings, because the
 * semantic categories are a closed vocabulary shared with the Gemini #3 review
 * contract - a new category there would change what the model is sent.
 *
 * Two severities, and the difference between them is the point:
 *
 *   definite  the evidence is conclusive from the text itself - or, for a rule
 *             that needs the source, from the requirement the case cites.
 *   warning   probably a problem, but a reading of the source or a QA policy
 *             decides it: alternatives that may be one equivalence class,
 *             conditions that may be stages of one sequence, a long checklist
 *             that may be meant as one end-to-end check, an intermediate step
 *             whose source cannot be linked to the case. When in doubt, warning.
 *
 * Every finding is experimental and advisory. Two rules are off by default
 * after a review of the first version (tcd-1) on the audited runs found no
 * finding of theirs that a reviewer could confirm, and ways for them to fire
 * on ordinary wording: TCD-ATOM-04 reads lists of columns or options as
 * variants, and TCD-VAGUE-02 reads "immediately forwarded" as a timing claim
 * and repeats what TCD-VAGUE-03 already asks of the same case. Their code and
 * tests stay, so they can be re-enabled per call (options.enableRules) once
 * revised; nothing they compute is reported unless asked for.
 *
 * Every finding carries the rule, the case, the field, a verbatim excerpt, the
 * reason and what to do. A rule that needs the source to decide says so when
 * the source is not available, rather than guessing at what it would say.
 * Wording is bilingual where the patterns are, because test cases are written
 * in the requirements' own language and that is usually Indonesian.
 */

export const TESTCASE_DIAGNOSTICS_VERSION = 'tcd-2';

export const DIAGNOSTIC_SEVERITIES = ['definite', 'warning'];

/** Rule ids are stable; the names are for people reading a report. */
export const DIAGNOSTIC_RULES = Object.freeze({
  'TCD-ATOM-01': 'multiple_conditional_branches',
  'TCD-ATOM-02': 'alternative_triggers',
  'TCD-ATOM-03': 'many_independent_outcomes',
  'TCD-ATOM-04': 'enumerated_variants',
  'TCD-VAGUE-01': 'unmeasurable_speed',
  'TCD-VAGUE-02': 'unmeasured_immediacy',
  'TCD-VAGUE-03': 'unenumerated_scope',
  'TCD-INTER-01': 'intermediate_step_only',
});

/** Rules that run only when a caller asks for them by id (see the header). */
export const DEFAULT_DISABLED_RULES = Object.freeze(['TCD-ATOM-04', 'TCD-VAGUE-02']);

// --- Text primitives -----------------------------------------------------------

const EXCERPT_RADIUS = 70;

/** A verbatim window around a match, so a finding can be checked by eye. */
function excerpt(text, start, end = start) {
  const from = Math.max(0, start - EXCERPT_RADIUS);
  const to = Math.min(text.length, end + EXCERPT_RADIUS);
  return `${from > 0 ? '…' : ''}${text.slice(from, to).trim()}${to < text.length ? '…' : ''}`;
}

/**
 * Which characters sit outside brackets and double quotes.
 *
 * A clause boundary inside "(Y.ISO.RESPONSE:1:1="01" and …)" or inside a quoted
 * message is not a boundary of the sentence. Single quotes are left alone on
 * purpose: they are apostrophes far more often than delimiters ("switching's").
 */
function topLevelMask(text) {
  const mask = new Array(text.length).fill(true);
  let depth = 0;
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      quoted = !quoted;
      mask[index] = false;
    } else if (char === '“' || char === '”') {
      quoted = char === '“';
      mask[index] = false;
    } else if (quoted) {
      mask[index] = false;
    } else if ('([{'.includes(char)) {
      depth += 1;
      mask[index] = false;
    } else if (')]}'.includes(char)) {
      depth = Math.max(0, depth - 1);
      mask[index] = false;
    } else {
      mask[index] = depth === 0;
    }
  }

  return mask;
}

/**
 * Splits at top-level semicolons and sentence ends, keeping offsets.
 *
 * A dot only ends a sentence when whitespace and a capital follow, so the dots
 * inside "Y.ISO.RESPONSE:1:1" or "00.00" never split anything.
 */
function segmentsOf(text) {
  const mask = topLevelMask(text);
  const segments = [];
  let start = 0;

  for (let index = 0; index < text.length; index += 1) {
    if (!mask[index]) continue;
    const char = text[index];
    const rest = text.slice(index + 1);
    const sentenceEnd =
      char === '.' && (rest.trim() === '' || (/^\s/.test(rest) && /^\s+\p{Lu}/u.test(rest)));

    if (char === ';' || sentenceEnd) {
      segments.push({ start, text: text.slice(start, index) });
      start = index + 1;
    }
  }
  if (start < text.length) segments.push({ start, text: text.slice(start) });

  return segments.filter((segment) => segment.text.trim() !== '');
}

/** A number with a unit of time or a percentage: something an observation can fail. */
const MEASURED =
  /\d+(?:[.,]\d+)?\s*(?:ms|milliseconds?|s|secs?|seconds?|minutes?|mins?|hours?|detik|menit|jam|%)(?![\p{L}])|\bp9[59]\b/iu;

// --- Conditions ------------------------------------------------------------------

/**
 * Words that open a condition. "upon" is left out deliberately: "upon clicking"
 * names the trigger of the main action, not a branch.
 */
const BRANCH_MARKER =
  /\b(?:if|when|whenever|unless|in case|jika|apabila|bila|ketika|kalau|dalam hal)\b/gi;

/** Idioms that look like a condition and are not one: "if any", "jika ada". */
const NOT_A_CONDITION =
  /^(?:if|jika|bila)\s+(?:any|applicable|needed|necessary|available|present|required|ada|perlu|diperlukan|tersedia)\b/i;

/** Top-level condition markers in a segment, with offsets into the segment. */
function markersIn(segment, mask) {
  const found = [];
  for (const match of segment.text.matchAll(BRANCH_MARKER)) {
    if (!mask[segment.start + match.index]) continue;
    if (NOT_A_CONDITION.test(segment.text.slice(match.index))) continue;
    found.push({ at: match.index, word: match[0] });
  }
  return found;
}

/** The condition a marker opens: up to the next top-level comma, or 120 characters. */
function conditionClause(segment, mask, at) {
  let end = segment.text.length;
  for (let index = at; index < segment.text.length; index += 1) {
    if (segment.text[index] === ',' && mask[segment.start + index]) {
      end = index;
      break;
    }
  }
  return segment.text.slice(at, Math.min(end, at + 120)).trim();
}

/** Words that end in -s/-ed/-ing and are not verbs often enough to matter here. */
const NOT_A_VERB = new Set([
  'its',
  'this',
  'thus',
  'is',
  'was',
  'has',
  'does',
  'as',
  'us',
  'plus',
  'status',
  'details',
  'records',
  'transactions',
  'rows',
  'items',
  'pages',
  'fields',
  'values',
  'users',
  'results',
  'settings',
  'options',
  'errors',
  'codes',
  'files',
  'cases',
  'times',
  'attempts',
  'retries',
  'during',
  'including',
  'following',
  'regarding',
  'according',
  'pending',
  'nothing',
  'something',
]);

/** Does this stretch of text, after a top-level comma, start a clause with its own verb? */
function opensClause(text) {
  const words = text.trim().split(/\s+/);
  const first = words[0]?.toLowerCase().replace(/[^\p{L}]/gu, '') ?? '';
  const lead = ['and', 'then', 'dan', 'lalu', 'serta', 'kemudian'].includes(first)
    ? (words[1]?.toLowerCase().replace(/[^\p{L}]/gu, '') ?? '')
    : first;

  if (!lead || NOT_A_VERB.has(lead)) return false;
  if (/(?:ing|ed|es|s)$/.test(lead) && lead.length > 3) return true;
  if (/^(?:me|di)\p{L}{4,}$/u.test(lead)) return true; // Indonesian verb prefixes
  return /^(?:the|a|an|it|this|system|sistem|transaksi)\b/.test(lead)
    ? /\b(?:is|are|was|were|will|must|shall|be|akan|harus)\b/i.test(text.split(',')[0])
    : false;
}

/** Whether a top-level comma in [from, to) is followed by a clause with its own verb. */
function consequenceBetween(segment, mask, from, to) {
  for (let index = from; index < to; index += 1) {
    if (segment.text[index] !== ',' || !mask[segment.start + index]) continue;
    if (opensClause(segment.text.slice(index + 1, to))) return true;
  }
  return false;
}

// --- TCD-ATOM-01: several conditional branches in one Expected Result ----------

/**
 * Counts branches - conditions that each carry their own outcome.
 *
 * Two markers count as two branches only when the first condition got its own
 * outcome before the second began (a clause with a verb after a top-level
 * comma), or when they sit in different sentences. "Not performed when A or
 * when B" is one outcome under alternative conditions - TCD-ATOM-02's business,
 * not this rule's. A second marker that restates the first condition is not a
 * second branch either.
 */
function branchesOf(text) {
  const mask = topLevelMask(text);
  const branches = [];

  for (const segment of segmentsOf(text)) {
    const markers = markersIn(segment, mask);
    markers.forEach((marker, index) => {
      if (index > 0) {
        const previous = markers[index - 1];
        const between = segment.text.slice(previous.at, marker.at);
        if (/\b(?:or|atau)\s*$/i.test(between)) return;
        if (!consequenceBetween(segment, mask, previous.at, marker.at)) return;
      }
      const clause = conditionClause(segment, mask, marker.at);
      const known = branches.some(
        (branch) => similarity(contentWords(branch.clause), contentWords(clause)) >= 0.8
      );
      if (!known) branches.push({ clause, at: segment.start + marker.at });
    });
  }

  return branches;
}

/**
 * A condition that builds on an earlier one - "if after the retry", "if it
 * still times out", "remains unresolved" - is a later stage of the same run,
 * not an alternative to it: one execution can pass through both.
 */
const SEQUENTIAL =
  /\b(?:after|still|again|also|remains?|remained|subsequent(?:ly)?|next|later|once|setelah|masih|lagi|kemudian|berikutnya)\b/i;

/** Negation, read with capitalised status names ("NOT FOUND") taken out first. */
const NEGATION = /\b(?:not|no|never|without|tidak|bukan|belum|tanpa)\b|n't\b/i;
const STATUS_NAMES = /\b[A-Z][A-Z_]+(?:\s+[A-Z][A-Z_]+)*\b/g;

/** Pairs of words that put the same subject on opposite sides. */
const OPPOSITES = [
  ['above', 'below'],
  ['over', 'under'],
  ['greater', 'less'],
  ['more', 'less'],
  ['higher', 'lower'],
  ['maximum', 'minimum'],
  ['active', 'inactive'],
  ['enabled', 'disabled'],
  ['valid', 'invalid'],
  ['available', 'unavailable'],
  ['sufficient', 'insufficient'],
  ['success', 'failed'],
  ['successful', 'failed'],
  ['true', 'false'],
  ['lebih', 'kurang'],
  ['cukup', 'kurang'],
  ['aktif', 'nonaktif'],
  ['berhasil', 'gagal'],
];

const lowerWords = (text) =>
  new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean)
  );
const NEGATION_WORDS = new Set([
  'not',
  'no',
  'never',
  'without',
  'tidak',
  'bukan',
  'belum',
  'tanpa',
]);

/** How alike two conditions must be once the flipped word is set aside. */
const SAME_CONDITION = 0.6;

/** The condition without its marker, the flipped words and the negations. */
function conditionCore(clause, flipped) {
  const words = contentWords(clause.replace(BRANCH_MARKER, ' '));
  return new Set([...words].filter((word) => !flipped.has(word) && !NEGATION_WORDS.has(word)));
}

/**
 * Whether two conditions clearly cannot hold in the same execution: the SAME
 * condition with one thing flipped - negated ("saldo cukup" / "saldo tidak
 * cukup") or turned to its opposite ("above" / "below", ACTIVE / INACTIVE).
 * Two conditions that merely share a subject ("response is FAILED" / "response
 * is FAILED and retry has not reached 3") are not, and neither is a condition
 * that builds on the earlier one. Anything short of that is a warning.
 */
function mutuallyExclusive(first, second) {
  if (SEQUENTIAL.test(second)) return false;

  const negated = (clause) => NEGATION.test(clause.replace(STATUS_NAMES, ' '));
  const a = lowerWords(first);
  const b = lowerWords(second);
  const opposite = OPPOSITES.find(
    ([one, other]) =>
      (a.has(one) && !a.has(other) && b.has(other) && !b.has(one)) ||
      (a.has(other) && !a.has(one) && b.has(one) && !b.has(other))
  );

  let flipped;
  if (opposite) flipped = new Set(opposite);
  else if (negated(first) !== negated(second)) flipped = new Set();
  else return false;

  return (
    similarity(conditionCore(first, flipped), conditionCore(second, flipped)) >= SAME_CONDITION
  );
}

function checkBranches(testCase) {
  const text = testCase.expected_result;
  const branches = branchesOf(text);
  if (branches.length < 2) return [];

  const exclusive = branches.some((branch, index) =>
    branches.slice(index + 1).some((later) => mutuallyExclusive(branch.clause, later.clause))
  );
  const evidence = branches.map((branch) => `"${branch.clause}"`).join(' | ');

  if (exclusive) {
    return [
      finding('TCD-ATOM-01', 'definite', testCase, 'expected_result', {
        evidence,
        reason: `The Expected Result states ${branches.length} separate conditions, each with its own outcome, and at least two of them cannot hold in the same execution. One execution can satisfy only one of those, so the other is reported as passed without being tested.`,
        action:
          'Split the case so that each condition and its outcome is one test case. Keep the wording of each outcome as the source states it.',
      }),
    ];
  }

  return [
    finding('TCD-ATOM-01', 'warning', testCase, 'expected_result', {
      evidence,
      reason: `The Expected Result states ${branches.length} separate conditions, each with its own outcome. They may be stages of one sequence that a single execution passes through, so whether the case must be split is a QA decision; if it stays one case, a partial run can still be reported as a pass.`,
      action:
        'Decide whether this sequence is one end-to-end case or one case per condition, and record that decision. If it stays one case, list each condition and its outcome as separate steps so a partial pass is visible.',
    }),
  ];
}

// --- TCD-ATOM-02: alternatives joined by "or" -------------------------------------

/**
 * Values that a condition can enumerate: a response or status code, a quoted
 * value, or a status word in capitals (FAILED, NOT FOUND). Lower-case words are
 * left out on purpose - "Settled or Released", "hover or click" read as
 * alternatives too, but also as synonyms and as one user gesture, and a rule
 * that cannot tell them apart would be ignored.
 */
// A two-word status may start with a short word ("NOT FOUND"); a one-word
// status needs four letters, so "DB", "FT" and "API" are not read as values.
// A code may end a sentence ("408 or 504."): only a dot, colon, slash or dash
// that continues into another character ("1.5", "10:30", "1/2", "2-3") makes
// the digits part of something else.
const CODE = String.raw`(?<![\w.:/-])\d{2,4}(?![\w%])(?![.:/-]\w)`;
const VALUE = String.raw`(?:${CODE}|"[^"\n]{1,60}"|“[^”\n]{1,60}”|(?<==)'[^'\n]{1,60}'|\b(?:[A-Z][A-Z_]{1,}\s+[A-Z][A-Z_]{2,}|[A-Z][A-Z_]{3,})\b)`;
const OR_WORD = String.raw`(?:or|OR|Or|atau|ATAU|Atau)`;
const ALTERNATIVE_PAIR = new RegExp(
  String.raw`(${VALUE})(?:\s*\([^()\n]{0,80}\))?\s+${OR_WORD}\s+(?:[a-z][\w.:]*\s+)?(${VALUE})`,
  'g'
);
/** "408, 504, or 68": a comma list is a list of alternatives only when it ends in "or". */
const COMMA_LIST = new RegExp(
  String.raw`${VALUE}(?:\s*,\s*(?:[a-z][\w.:]*\s+)?${VALUE})+\s*,?\s+${OR_WORD}\s+(?:[a-z][\w.:]*\s+)?${VALUE}`,
  'g'
);
/**
 * "FAILED/NOT FOUND", "408/504/68". Numbers only when at least one is a
 * three-digit code and none is a year, so "10/12" and "14/10/26" stay dates.
 * Read only inside a condition, where they name what triggers the case.
 */
const SLASH_STATUS =
  /\b(?:[A-Z][A-Z_]{1,}\s+[A-Z][A-Z_]{2,}|[A-Z][A-Z_]{3,})(?:\s?\/\s?(?:[A-Z][A-Z_]{1,}\s+[A-Z][A-Z_]{2,}|[A-Z][A-Z_]{3,}))+\b/g;
const SLASH_CODES = /(?<![\w.:/-])\d{2,3}(?:\s?\/\s?\d{2,3})+(?![\w%])(?![.:/-]\w)/g;
const valuesIn = (text) => [...text.matchAll(new RegExp(VALUE, 'g'))].map((match) => match[0]);

/** Capitalised words that are names of things, not values a condition takes. */
const NOT_A_STATUS = new Set([
  'QRIS',
  'HTTP',
  'HTTPS',
  'JSON',
  'SFTP',
  'TTTP',
  'XLSX',
  'HTML',
  'REST',
  'SOAP',
]);

const isStatusWord = (value) => /^[A-Z]/.test(value) && !/^["“']/.test(value);

/** Chains of values joined by "or": "408 or 504 or responseCode 68". */
function alternativeChains(text) {
  const pairs = [];
  const pattern = new RegExp(ALTERNATIVE_PAIR.source, 'g');
  let match;

  while ((match = pattern.exec(text))) {
    const [whole, first, second] = match;
    const secondAt = match.index + whole.lastIndexOf(second);
    pairs.push({ start: match.index, end: match.index + whole.length, first, second });
    pattern.lastIndex = secondAt;
  }

  const chains = [];
  for (const pair of pairs) {
    const last = chains.at(-1);
    if (last && pair.start < last.end) {
      last.end = pair.end;
      last.values.push(pair.second);
    } else {
      chains.push({ start: pair.start, end: pair.end, values: [pair.first, pair.second] });
    }
  }

  // A comma list ending in "or" replaces the "or" pair found at its tail.
  for (const match of text.matchAll(COMMA_LIST)) {
    const start = match.index;
    const end = start + match[0].length;
    for (let index = chains.length - 1; index >= 0; index -= 1) {
      if (chains[index].start < end && chains[index].end > start) chains.splice(index, 1);
    }
    chains.push({ start, end, values: valuesIn(match[0]) });
  }

  for (const pattern of [SLASH_STATUS, SLASH_CODES]) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (chains.some((chain) => chain.start < end && chain.end > start)) continue;
      const values = match[0].split(/\s?\/\s?/);
      if (pattern === SLASH_CODES && !values.some((value) => value.length === 3)) continue;
      chains.push({ start, end, values, slash: true });
    }
  }
  chains.sort((left, right) => left.start - right.start);

  return chains.filter((chain) => {
    const distinct = new Set(chain.values.map((value) => value.toLowerCase()));
    if (distinct.size < 2) return false;
    return !chain.values.some(
      (value) => isStatusWord(value) && NOT_A_STATUS.has(value.split(/\s+/)[0])
    );
  });
}

/** Whether position `at` lies after a top-level condition marker of its own segment. */
function insideCondition(text, at) {
  const mask = topLevelMask(text);
  const segment = segmentsOf(text).find(
    (candidate) => at >= candidate.start && at < candidate.start + candidate.text.length
  );
  if (!segment) return false;
  return markersIn(segment, mask).some((marker) => segment.start + marker.at < at);
}

/** "… when A or when B": one outcome under alternative conditions. */
const ALTERNATIVE_CONDITION =
  /\b(?:if|when|whenever|jika|apabila|bila|ketika)\b[^;.]{3,200}?,?\s+(?:or|atau)\s+(?:when|if|whenever|jika|apabila|bila|ketika)\b/gi;

function checkAlternatives(testCase) {
  for (const field of ['expected_result', 'test_case']) {
    const text = testCase[field];

    for (const chain of alternativeChains(text)) {
      // A capitalised status listed outside any condition ("identifies FAILED or
      // NOT FOUND") describes data, not a trigger; codes and quoted values are
      // alternatives wherever they are joined by "or". A slash says less than
      // "or" ("PENDING / SUCCESS" can be a legend), so it counts only inside a
      // condition.
      const statusOnly = chain.values.every(isStatusWord);
      if ((statusOnly || chain.slash) && !insideCondition(text, chain.start)) continue;

      const names = chain.values.map((value) => value.trim()).join(' / ');
      const joined = chain.slash ? 'joined by "/"' : 'joined by "or"';

      // Codes are distinct values by construction. A status name is not: two
      // names may be two responses, or one response under two names (FAILED and
      // NOT FOUND can share a code). Which one is a question for the source or
      // the SME, so the finding asks it instead of assuming the answer.
      if (chain.values.some(isStatusWord)) {
        return [
          finding('TCD-ATOM-02', 'warning', testCase, field, {
            evidence: excerpt(text, chain.start, chain.end),
            reason: `${names} are named as alternatives ${joined} in one case. If they are distinct responses, one execution exercises only one of them and the result does not say which; if they are one response under two names, the case is fine. The text does not decide which.`,
            action:
              'Confirm with the source or the SME whether these are distinct responses before splitting or merging. If distinct, write one case per value; if one, name the single value the case uses. Do not decide it by assumption.',
          }),
        ];
      }

      return [
        finding('TCD-ATOM-02', 'warning', testCase, field, {
          evidence: excerpt(text, chain.start, chain.end),
          reason: `${names} are alternatives ${joined} in one case. A tester exercises one of them; the others are not verified, and the result does not say which one passed.`,
          action:
            'Write one case per alternative, or record - with the source or a QA decision - that they are one equivalence class and name the value to use. Do not merge them by assumption.',
        }),
      ];
    }

    for (const match of text.matchAll(ALTERNATIVE_CONDITION)) {
      return [
        finding('TCD-ATOM-02', 'warning', testCase, field, {
          evidence: excerpt(text, match.index, match.index + match[0].length),
          reason:
            'Two separate conditions are joined by "or … when/if" in one case. Each is its own path to the outcome, and one execution tests only one of them.',
          action:
            'Write one case per condition so that each path is executed and judged on its own.',
        }),
      ];
    }
  }

  return [];
}

// --- TCD-ATOM-03: a checklist of independent outcomes ------------------------------

/**
 * Concrete, checkable facts an Expected Result asserts: clock times, day
 * offsets, durations, file names and extensions, delimiters, quoted values,
 * constant-style identifiers, status words and codes. Each one is a separate
 * thing a tester has to look at.
 */
const FACT_PATTERNS = [
  /(?<![\w.])\d{1,2}[.:]\d{2}(?![\w.:])/g,
  /\b[DH][+-]\d+\b/g,
  /\b\d+(?:[.,]\d+)?\s*(?:ms|milliseconds?|seconds?|secs?|minutes?|mins?|hours?|days?|detik|menit|jam|hari)\b/gi,
  /(?<![\w.])(?:[\w-]+)?\.(?:txt|csv|xlsx?|json|xml|pdf|tmp|zip|dat|log)\b/gi,
  /\btilde\b|\bpipe\b|(?<=\s)[~|](?=\s)/gi,
  /"[^"\n]{1,60}"|“[^”\n]{1,60}”|(?<==)'[^'\n]{1,60}'/g,
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g,
  /\b[A-Z]{4,}(?:\s+[A-Z]{3,})?\b/g,
  /(?<![\w.:/-])\d{2,4}(?![\w.:/%-])/g,
];

function factsOf(text) {
  const raw = new Set();
  for (const pattern of FACT_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const fact = match[0]
        .trim()
        .toLowerCase()
        .replace(/^tilde$/, '~');
      if (fact && !NOT_A_STATUS.has(match[0].trim())) raw.add(fact);
    }
  }
  // "settlement_x.txt" already says ".txt" and "SETTLEMENT_X".
  const facts = [...raw];
  return facts.filter((fact) => !facts.some((other) => other !== fact && other.includes(fact)));
}

/** Clauses with their own verb, split at top-level semicolons and commas. */
function outcomeClauses(text) {
  const mask = topLevelMask(text);
  let count = 0;

  for (const segment of segmentsOf(text)) {
    count += 1;
    for (let index = 0; index < segment.text.length; index += 1) {
      if (segment.text[index] !== ',' || !mask[segment.start + index]) continue;
      const next = segment.text.slice(index + 1).split(',')[0];
      if (opensClause(next)) count += 1;
    }
  }

  return count;
}

/** Tuned on development data only (see the Phase 1 report); a warning, never definite. */
const MANY_FACTS = 6;
const MANY_CLAUSES = 3;

function checkOutcomeCount(testCase) {
  const text = testCase.expected_result;
  const facts = factsOf(text);
  const clauses = outcomeClauses(text);
  if (facts.length < MANY_FACTS || clauses < MANY_CLAUSES) return [];

  return [
    finding('TCD-ATOM-03', 'warning', testCase, 'expected_result', {
      evidence: `${clauses} outcome clauses; facts: ${facts.join(', ')}`,
      reason: `The Expected Result checks ${facts.length} separate facts across ${clauses} outcome clauses. If one fails, the case fails without saying which, and a partial check can be reported as a pass.`,
      action:
        'Consider one case per independently verifiable output (for example timing, data window, file name, format, location). Keep it as one end-to-end case only if QA decides that is the intended check.',
    }),
  ];
}

// --- TCD-ATOM-04: enumerated variants in one case ------------------------------------

/** "(Transfer, Setor, Tarik)": three short items, no values or assignments. */
const ENUMERATION = /\(([^()\n]{3,120})\)/g;

function checkEnumeration(testCase) {
  const text = testCase.test_case;

  for (const match of text.matchAll(ENUMERATION)) {
    const inside = match[1].trim();
    if (/^(?:e\.g\.|i\.e\.|eg|ie|contoh|misal)/i.test(inside)) continue;
    if (/[=:"“]|\d/.test(inside)) continue;

    const items = inside.split(/\s*,\s*(?:and\s+|or\s+|dan\s+|atau\s+)?/).filter(Boolean);
    if (items.length < 3 || items.some((item) => item.split(/\s+/).length > 3)) continue;

    return [
      finding('TCD-ATOM-04', 'warning', testCase, 'test_case', {
        evidence: excerpt(text, match.index, match.index + match[0].length),
        reason: `The case names ${items.length} variants (${items.join(', ')}) at once. One execution exercises one variant; the rest are claimed without being run.`,
        action:
          'Write one case per variant, or state which variant this case executes. If the source treats them identically, record that decision explicitly.',
      }),
    ];
  }

  return [];
}

// --- TCD-VAGUE-01/02/03: criteria no observation can fail -----------------------------

/**
 * Speed words. Matched in lower case only, so a feature named "Quick Pay" or
 * "Akses Cepat" is never read as a performance claim.
 */
const SPEED =
  /(?<![\p{L}])(?:quickly|quick|fast|faster|rapidly|rapid|promptly|swiftly|speedily|speedy|responsively|responsive|in a timely manner|timely|as soon as possible|without (?:any |noticeable |significant )?(?:delay|lag)|dengan cepat|cepat|secepatnya|secepat mungkin|tanpa jeda|tanpa penundaan|responsif)(?![\p{L}])/gu;

/**
 * Adjectives that are also used to name things: "quick search box", "fast-track
 * approval", "menu akses cepat". They express an unmeasured quality only as a
 * predicate ("the page is fast", "harus cepat"), at the end of a clause ("loads
 * fast."), or before a noun that is itself a performance ("fast response").
 * Adverbs and phrases ("quickly", "without delay", "dengan cepat") always do.
 */
const SPEED_ADJECTIVES = new Set([
  'quick',
  'fast',
  'faster',
  'rapid',
  'speedy',
  'responsive',
  'timely',
  'cepat',
  'responsif',
]);
const PREDICATE_BEFORE =
  /(?:\b(?:is|are|be|been|being|remains?|stays?|feels?|seems?|appears?|becomes?|must|should|shall|will|very|sufficiently|reasonably|harus|tetap|terasa|lebih|sangat|cukup|akan|tampil|terlihat)\s+)$/i;
const CLAUSE_END_AFTER = /^\s*(?:[.,;:!?)]|$|(?:and|or|than|enough|dan|atau|daripada)\b)/i;
const PERFORMANCE_NOUN =
  /^\s+(?:response|responses|load|loading|loads|performance|retrieval|processing|rendering|display|access|turnaround|startup|execution|delivery|respons|pemuatan|kinerja|proses)\b/i;

function isSpeedClaim(text, match) {
  const word = match[0];
  if (!SPEED_ADJECTIVES.has(word)) return true;
  const after = text.slice(match.index + word.length);
  if (/^-\p{L}/u.test(after)) return false; // a compound term: "fast-track"
  const before = text.slice(0, match.index);
  return (
    PREDICATE_BEFORE.test(before) || CLAUSE_END_AFTER.test(after) || PERFORMANCE_NOUN.test(after)
  );
}

/** "Immediately" and its kin: a timing claim, or an ordering one. */
const IMMEDIACY = /(?<![\p{L}])(?:immediately|instantly|segera)(?![\p{L}])/gu;

/**
 * "Immediately rejected" says nothing else happens first - an ordering the
 * test can observe - not a response time. Those are left alone.
 */
const ORDERING =
  /\b(?:reject\w*|declin\w*|stop\w*|terminat\w*|abort\w*|cancel\w*|fail\w*|block\w*|deni\w*|deny|ditolak|tolak|menolak|dibatalkan|dihentikan|gagal|diblokir)\b/i;

/** "all data states", "berbagai kondisi": a scope nobody listed. */
const UNENUMERATED =
  /\b(?:all|any|every|various|different|semua|berbagai|setiap)\s+(?:possible\s+|kinds?\s+of\s+|types?\s+of\s+|jenis\s+)?(?:data\s+)?(?:states|conditions|scenarios|situations|circumstances|kondisi|keadaan|skenario|situasi)\b/gi;

/** What the source says about a measurable threshold, when there is a source. */
function thresholdNote(context) {
  if (context.kind === 'unavailable') {
    return {
      note: 'Source context is not available here, so whether the source states a threshold is unknown.',
      evidence: null,
    };
  }
  const text = sourceText(context.requirements);
  const measured = text.match(MEASURED);
  if (measured) {
    // Only offered, never adopted: a number near the requirement may be the
    // target, or only the baseline it improves on ("currently 28 seconds").
    return {
      note: `The ${context.kind === 'cited' ? 'cited requirement' : 'project'} states a measurable value (see source_evidence); check whether it is the target or only a baseline before using it.`,
      evidence: excerpt(text, measured.index, measured.index + measured[0].length),
    };
  }
  return {
    note: `The ${context.kind === 'cited' ? 'cited requirement' : 'project'} states no threshold either: this is a source gap for the SME, not something to fill in.`,
    evidence: null,
  };
}

function checkVagueness(testCase, context) {
  const text = testCase.expected_result;
  // A stated time limit makes "quickly" and "immediately" measurable; it says
  // nothing about which data states are meant, so it does not silence that rule.
  const measured = MEASURED.test(text);
  const found = [];

  const speed = measured
    ? null
    : [...text.matchAll(SPEED)].find((match) => isSpeedClaim(text, match));
  if (speed) {
    const { note, evidence } = thresholdNote(context);
    found.push(
      finding('TCD-VAGUE-01', 'definite', testCase, 'expected_result', {
        evidence: excerpt(text, speed.index, speed.index + speed[0].length),
        reason: `"${speed[0]}" has no measurable threshold, so no observation can fail this Expected Result. ${note}`,
        action:
          'Replace it with a threshold the source states (time, data volume, conditions). If the source states none, mark the case as waiting for an SME threshold - do not invent a number.',
        sourceContext: context.kind,
        sourceEvidence: evidence,
      })
    );
  }

  for (const match of measured ? [] : text.matchAll(IMMEDIACY)) {
    const window =
      text
        .slice(Math.max(0, match.index - 40), match.index + match[0].length + 40)
        .split(/[,;]/)
        .find((part) => part.includes(match[0])) ?? '';
    if (ORDERING.test(window)) continue;

    found.push(
      finding('TCD-VAGUE-02', 'warning', testCase, 'expected_result', {
        evidence: excerpt(text, match.index, match.index + match[0].length),
        reason: `"${match[0]}" reads as a response-time claim with no threshold. If it only means "before anything else happens", the Expected Result should say what is observed instead.`,
        action:
          'Either state the observable ordering (what must not happen first) or a time limit taken from the source; if the source gives neither, record it as an SME question.',
      })
    );
    break;
  }

  for (const field of ['expected_result', 'test_case']) {
    const match = [...testCase[field].matchAll(UNENUMERATED)][0];
    if (!match) continue;
    found.push(
      finding('TCD-VAGUE-03', 'warning', testCase, field, {
        evidence: excerpt(testCase[field], match.index, match.index + match[0].length),
        reason: `"${match[0]}" does not say which states are meant, so the case cannot show it checked all of them.`,
        action:
          'List the states to execute (for example: no data, one record, a date range longer than one day), taken from the source. If the source does not enumerate them, ask the SME.',
      })
    );
    break;
  }

  return found;
}

// --- TCD-INTER-01: an intermediate step with no end result ------------------------------

/** "proceeds to (the next | specific route) validation", "lanjut ke validasi berikutnya". */
const INTERMEDIATE =
  /\b(?:proceed(?:s|ed|ing)?|continue(?:s|d)?|move(?:s|d)?(?:\s+on)?|go(?:es)?\s+on|lanjut(?:kan)?|melanjutkan|diteruskan)\s+(?:to\s+|with\s+|ke\s+)?(?:the\s+)?(?:next|specific(?:\s+route)?|further|subsequent|following|berikut(?:nya)?|selanjutnya)?\s*(?:route\s+)?(?:validations?|checks?|steps?|stages?|process(?:ing)?|verification|validasi|tahap|proses|langkah|pengecekan)\b(?:\s+(?:berikut(?:nya)?|selanjutnya)\b)?/gi;

/** Words that carry no assertion once the step and the condition are removed. */
const FILLER = new Set([
  'the',
  'a',
  'an',
  'system',
  'transaction',
  'transactions',
  'it',
  'and',
  'then',
  'also',
  'sistem',
  'transaksi',
  'akan',
  'lalu',
  'dan',
  'kemudian',
  'request',
  'requests',
]);

/** The Expected Result with intermediate steps and condition clauses taken out. */
function assertionsBeyondSteps(text) {
  const stripped = text.replace(INTERMEDIATE, ' ');
  const mask = topLevelMask(stripped);
  const parts = [];

  for (const segment of segmentsOf(stripped)) {
    const markers = markersIn(segment, mask);
    let kept = segment.text;
    if (markers.length > 0) {
      const first = markers[0].at;
      if (segment.text.slice(0, first).trim() === '') {
        // "When X, the system …": drop the condition up to its comma.
        const clause = conditionClause(segment, mask, first);
        kept = segment.text.slice(first + clause.length);
      } else {
        // "The system … when X": drop from the condition to the end.
        kept = segment.text.slice(0, first);
      }
    }
    parts.push(kept);
  }

  return parts
    .join(' ')
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((word) => word && !FILLER.has(word));
}

/** An outcome stated after the step in the source: "IF ACTIVE, then send …". */
const FOLLOWING_OUTCOME =
  /\b(?:send|sends|use|uses|reject|rejects|display|displays|show|shows|mark|marks|update|updates|route|routes|forward|forwards|return|returns|save|saves|create|creates|trigger|triggers|kirim|tolak|tampilkan|simpan)\b/i;

const SOURCE_LOOKAHEAD = 400;

function sourceContinuation(context) {
  const text = sourceText(context.requirements);
  for (const match of text.matchAll(INTERMEDIATE)) {
    const after = text.slice(
      match.index + match[0].length,
      match.index + match[0].length + SOURCE_LOOKAHEAD
    );
    const outcome = after.match(FOLLOWING_OUTCOME);
    if (outcome) {
      const at = match.index + match[0].length + outcome.index;
      return {
        found: true,
        continues: true,
        evidence: excerpt(text, match.index, at + outcome[0].length),
      };
    }
  }
  // A fresh, non-global copy: .test() on the shared /g pattern would carry its
  // lastIndex from one call into the next.
  return {
    found: new RegExp(INTERMEDIATE.source, 'i').test(text),
    continues: false,
    evidence: null,
  };
}

function checkIntermediate(testCase, context) {
  const text = testCase.expected_result;
  const step = [...text.matchAll(INTERMEDIATE)][0];
  if (!step) return [];
  if (assertionsBeyondSteps(text).length > 0) return [];

  const evidence = excerpt(text, step.index, step.index + step[0].length);
  const base = {
    evidence,
    action:
      'Add the observable end result the source requires after this step (for example where the transaction is sent, or that it is rejected with which code), or merge this case into the case that checks that result.',
  };

  if (context.kind === 'unavailable') {
    return [
      finding('TCD-INTER-01', 'warning', testCase, 'expected_result', {
        ...base,
        reason:
          'The Expected Result only says the system moves on to a further step and states no observable end result. Source context is not available here, so whether the source requires a further result is unknown.',
        sourceContext: 'unavailable',
      }),
    ];
  }

  // The whole project is not this case's source. Its first "proceed … then
  // send" may belong to another section entirely, and a section that really
  // ends at this step would be judged by it - so project text is never quoted
  // as evidence and never makes the finding definite.
  if (context.kind === 'project') {
    return [
      finding('TCD-INTER-01', 'warning', testCase, 'expected_result', {
        ...base,
        reason:
          'The Expected Result only says the system moves on to a further step and states no observable end result. The case cites no requirement that could be found, so the source cannot be linked to it and whether a further result is required was not checked.',
        sourceContext: 'project',
      }),
    ];
  }

  const source = sourceContinuation(context);
  if (source.continues) {
    return [
      finding('TCD-INTER-01', 'definite', testCase, 'expected_result', {
        ...base,
        reason:
          'The Expected Result stops at an intermediate step, while the source goes on to state what must happen after it. Passing this case shows only that the step was reached, not that the required result occurred.',
        sourceContext: context.kind,
        sourceEvidence: source.evidence,
      }),
    ];
  }

  if (source.found) return []; // the source itself ends at this step: nothing further is required

  return [
    finding('TCD-INTER-01', 'warning', testCase, 'expected_result', {
      ...base,
      reason:
        'The Expected Result only says the system moves on to a further step, and the available source does not mention this step, so the required end result could not be checked.',
      sourceContext: context.kind,
    }),
  ];
}

// --- Assembly ------------------------------------------------------------------------------

function finding(
  ruleId,
  severity,
  testCase,
  field,
  { evidence, reason, action, sourceContext = 'not_needed', sourceEvidence = null }
) {
  return {
    rule_id: ruleId,
    rule: DIAGNOSTIC_RULES[ruleId],
    severity,
    testcase_id: testCase.case_id ?? null,
    field,
    evidence,
    reason,
    action,
    source_context: sourceContext,
    source_evidence: sourceEvidence,
  };
}

function sourceText(requirements) {
  return requirements
    .flatMap((requirement) => [
      requirement.title,
      requirement.description,
      ...(requirement.source_references ?? []).map((reference) => reference.quote),
    ])
    .filter((part) => typeof part === 'string' && part !== '')
    .join('\n');
}

/**
 * The source a case may be judged against: its cited requirements, or - for a
 * case that cites none - the whole project, which is the most generous reading
 * available. Never invented: with no requirements at all, there is no context.
 */
function contextFor(testCase, requirementsById, requirements) {
  const cited = (Array.isArray(testCase.requirement_ids) ? testCase.requirement_ids : [])
    .map((requirementId) => requirementsById.get(requirementId))
    .filter(Boolean);
  if (cited.length > 0) return { kind: 'cited', requirements: cited };
  if (requirements.length > 0) return { kind: 'project', requirements };
  return { kind: 'unavailable', requirements: [] };
}

/** The fields the rules read, as strings, whatever the case arrived with. */
function readable(testCase) {
  return {
    ...testCase,
    test_case: typeof testCase.test_case === 'string' ? testCase.test_case : '',
    expected_result: typeof testCase.expected_result === 'string' ? testCase.expected_result : '',
  };
}

/**
 * The rules that stay off for a call: the default-disabled ones, minus any the
 * caller re-enables by id. Unknown ids are ignored rather than trusted.
 */
function disabledRules(options) {
  const enable = new Set(Array.isArray(options?.enableRules) ? options.enableRules : []);
  return DEFAULT_DISABLED_RULES.filter((ruleId) => !enable.has(ruleId));
}

/**
 * All findings for one case, at most one per rule. `options.enableRules` turns
 * on rules that are disabled by default; nothing else changes with options.
 */
export function diagnoseTestCase(
  testCase,
  context = { kind: 'unavailable', requirements: [] },
  options = {}
) {
  const subject = readable(testCase);
  const off = new Set(disabledRules(options));
  const all = [
    ...checkBranches(subject),
    ...checkAlternatives(subject),
    ...checkOutcomeCount(subject),
    ...checkEnumeration(subject),
    ...checkVagueness(subject, context),
    ...checkIntermediate(subject, context),
  ];
  const seen = new Set();
  return all.filter(
    (item) => !off.has(item.rule_id) && !seen.has(item.rule_id) && seen.add(item.rule_id)
  );
}

function emptySummary() {
  return {
    total: 0,
    definite: 0,
    warning: 0,
    testcases_flagged: 0,
    by_rule: Object.fromEntries(Object.keys(DIAGNOSTIC_RULES).map((ruleId) => [ruleId, 0])),
  };
}

function summarize(findings) {
  const summary = emptySummary();
  for (const item of findings) {
    summary.total += 1;
    summary[item.severity] += 1;
    summary.by_rule[item.rule_id] += 1;
  }
  summary.testcases_flagged = new Set(findings.map((item) => item.testcase_id)).size;
  return summary;
}

const SEVERITY_ORDER = Object.fromEntries(
  DIAGNOSTIC_SEVERITIES.map((severity, index) => [severity, index])
);

/** A result in the same shape when nothing ran, so the caller never branches on absence. */
export function skippedDiagnostics(reason) {
  return {
    rules_version: TESTCASE_DIAGNOSTICS_VERSION,
    status: 'skipped',
    reason,
    disabled_rules: disabledRules(),
    findings: [],
    summary: emptySummary(),
  };
}

/**
 * Diagnoses every test case of a canonical project. Pure: the project is read,
 * never written, and the same project always gives the same findings.
 *
 * `disabled_rules` names the rules that did not run, so a zero in
 * `summary.by_rule` is never mistaken for a clean result from a rule that was off.
 *
 * @param {{requirements?: object[], test_cases?: object[]}} canonical
 * @param {{enableRules?: string[]}} [options]
 * @returns {{rules_version: string, status: string, reason: string|null, disabled_rules: string[], findings: object[], summary: object}}
 */
export function diagnoseTestCases(canonical, options = {}) {
  const requirements = Array.isArray(canonical?.requirements) ? canonical.requirements : [];
  const testCases = Array.isArray(canonical?.test_cases) ? canonical.test_cases : [];
  const requirementsById = new Map(
    requirements.map((requirement) => [requirement.requirement_id, requirement])
  );

  const findings = testCases
    .flatMap((testCase) =>
      diagnoseTestCase(testCase, contextFor(testCase, requirementsById, requirements), options)
    )
    .sort(
      (left, right) =>
        SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity] ||
        String(left.testcase_id).localeCompare(String(right.testcase_id)) ||
        left.rule_id.localeCompare(right.rule_id)
    );

  return {
    rules_version: TESTCASE_DIAGNOSTICS_VERSION,
    status: 'completed',
    reason: null,
    disabled_rules: disabledRules(options),
    findings,
    summary: summarize(findings),
  };
}
