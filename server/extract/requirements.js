import { formatSequentialId, ID_PREFIX } from '../lib/ids.js';
import { isNoise } from './noise.js';
import { buildSourceReference } from './blocks.js';

/**
 * Deterministic requirement selection.
 *
 * Extraction is not interpretation. Nothing here writes a requirement that is
 * not present in the source text: a block is selected or it is not, and the
 * text that survives is the document's own wording, lightly tidied. The LLM
 * arrives in milestone 4 and works from what QA sees here.
 *
 * Everything is bilingual. The real PRDs and RFCs are written in Indonesian
 * with English technical terms mixed in, so `harus` and `wajib` carry exactly
 * as much weight as `must` and `shall`.
 */

/** Language that marks a statement as a requirement rather than description. */
const REQUIREMENT_SIGNALS = [
  // English
  /\b(must|shall|should|will|has to|have to|needs? to|required to)\b/i,
  /\b(is|are)\s+(required|mandatory|prohibited|rejected|validated|restricted|disabled|enabled)\b/i,
  /\b(cannot|can not|may not|must not|shall not|not allowed|not permitted)\b/i,
  /\b(reject|rejected|decline|declined|fail|failed|error|invalid|timeout)\b/i,
  /\b(validate|validation|verify|ensure|enforce|restrict|limit)\b/i,
  /\b(maximum|minimum|max|min|at most|at least|exceed|exceeds|up to)\b/i,
  /\bif\b.+\bthen\b/i,
  // Indonesian
  /\b(harus|wajib|dilarang|tidak\s+boleh|tidak\s+dapat|tidak\s+diperbolehkan)\b/i,
  /\b(ditolak|gagal|kesalahan|salah|tidak\s+valid|kadaluarsa)\b/i,
  /\b(divalidasi|validasi|memastikan|dibatasi|dinonaktifkan|diaktifkan)\b/i,
  /\b(maksimal|minimal|paling\s+banyak|paling\s+sedikit|melebihi|sampai\s+dengan)\b/i,
  /\b(apabila|jika|ketika)\b.+\b(maka|akan)\b/i,
  /\b(dapat|akan|menjadi)\b/i,
];

/**
 * Category rules, in priority order: the first match wins.
 *
 * Categorisation is a heuristic and the order encodes a judgement. Input
 * Validation sits above Error Handling because a validation rule almost always
 * names the error it produces - "mandatory field ... rejected with ADMI 002" is
 * a validation requirement that happens to mention an error code - whereas a
 * genuine error-handling requirement (timeout, rollback, reversal) rarely
 * borrows validation vocabulary. Putting them the other way round pulls most
 * validation rules into Error Handling.
 *
 * The category is a starting point for review, not a verdict. Categories are
 * exactly PRD 7's list.
 */
const CATEGORY_RULES = [
  {
    category: 'Input Validation',
    pattern:
      /\b(validat\w*|mandatory|required field|format|length|pattern|empty|blank|null|wajib\s+diisi|validasi|format)\b/i,
  },
  {
    category: 'Error Handling',
    pattern:
      /\b(error|exception|reject(ed|ion)?|decline[ds]?|fail(ed|ure)?|rollback|reversal|kesalahan|ditolak|gagal|pembatalan)\b/i,
  },
  {
    /**
     * A prohibition is a rule about what someone may do, so it is classified
     * here rather than as a Constraint - which would otherwise claim it
     * whenever the sentence happens to contain a word like "limit", which is
     * frequently a column name rather than a numeric bound.
     */
    category: 'Business Rule',
    pattern:
      /\b(rule|policy|eligib\w*|entitle\w*|permission|authoriz\w*|prohibited|not\s+allowed|not\s+permitted|may\s+not|ketentuan|aturan|kebijakan|kewenangan|tidak\s+boleh|dilarang|tidak\s+diperbolehkan)\b/i,
  },
  {
    category: 'Constraint',
    pattern:
      /\b(maximum|minimum|max|min|limit|ceiling|threshold|timeout|exceed\w*|at\s+most|at\s+least|up\s+to|maksimal|minimal|batas|melebihi)\b/i,
  },
  {
    category: 'Status/State',
    pattern:
      /\b(status|state|active|inactive|suspend\w*|pending|dormant|blocked|closed|aktif|nonaktif|ditangguhkan|tertunda)\b/i,
  },
  {
    category: 'Integration/Dependency',
    pattern:
      /\b(api|endpoint|service|interface|integration|connector|sftp|host[\s-]?to[\s-]?host|webhook|queue|downstream|upstream|integrasi|antarmuka)\b/i,
  },
  {
    category: 'Data/Field Mapping',
    pattern:
      /\b(field|column|mapping|maps? to|populated|derived from|data element|kolom|pemetaan|dipetakan)\b/i,
  },
  {
    category: 'Expected Behavior',
    pattern:
      /\b(display\w*|show[ns]?|return[ns]?|appear[s]?|generate[ds]?|record(ed|s)?|log(ged|s)?|notify|menampilkan|hasil|tercatat)\b/i,
  },
];

/** Vagueness that a reviewer should be told about rather than have smoothed over. */
const AMBIGUITY_RULES = [
  {
    pattern: /\b(etc\.?|and so on|dll\.?|dan lain-lain|dsb\.?)\b/i,
    note: 'Ends with an open-ended list, so the full set of cases is not stated.',
  },
  {
    pattern: /\b(tbd|tba|tbc|to be (determined|advised|confirmed)|menyusul|akan ditentukan)\b/i,
    note: 'Marked as undecided in the source document.',
  },
  {
    pattern:
      /\b(as (needed|appropriate|required)|if necessary|where applicable|sesuai kebutuhan|jika diperlukan|bila perlu)\b/i,
    note: 'Condition is discretionary, with no stated trigger.',
  },
  {
    pattern:
      /\b(some|several|various|appropriate|reasonable|sufficient|beberapa|sesuai|memadai)\b/i,
    note: 'Uses an unquantified term, so the threshold to test against is not defined.',
  },
  {
    pattern: /\?\s*$/,
    note: 'Source text is phrased as a question rather than a statement.',
  },
];

const MIN_REQUIREMENT_LENGTH = 25;
const MAX_TITLE_LENGTH = 120;

/**
 * Identifiers a document defines and a test has to quote exactly: error codes,
 * response codes, named constants. A statement carrying one is a documented
 * rule, however short the parser left it.
 */
const DOCUMENTED_IDENTIFIER =
  /\b(?:[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|HTTP\s?\d{3}|[A-Z]{2,6}[ -]?\d{2,4})\b/;

/**
 * Length is a noise filter, not a judgement about importance.
 *
 * It exists to keep page numbers and stray labels out of the requirement list,
 * and for that it earns its place. But it cost a real rule once: a wrapped
 * line left "code ERR_INVALID_AMOUNT." standing alone at 24 characters, one
 * short of the threshold, and a documented error requirement disappeared with
 * no warning. So anything naming a documented identifier, and any table row
 * that arrived as structured data, is kept whatever its length - and short
 * survivors are flagged below rather than trusted.
 */
function isRequirementCandidate(block) {
  if (block.kind === 'heading') return false;

  // An image region is a note about content that was NOT read. It names a page
  // and a lead-in so a reviewer can go and look; its own words - "[Image on
  // page 6 ... was not read.]" - are this system's, not the document's, and
  // nothing downstream should mistake them for a requirement. It reaches QA as
  // a warning instead.
  if (block.kind === 'image_region') return false;

  // An image TRANSCRIPTION is the opposite case, and it skips the filters
  // below entirely. A named person read the picture and wrote down what it
  // says, declaring that text to be the contract; the heuristics here exist to
  // sift automatically extracted blocks, and re-judging a human's deliberate
  // statement by them drops real content. Measured: "Write AMOUNT as Decimal 2
  // digits" is a stated output format and carries none of the signals a
  // requirement is recognised by, so it vanished.
  if (block.kind === 'image_transcription') return true;

  const structured = block.kind === 'table-row' && block.table?.headers.length > 0;
  const namesIdentifier = DOCUMENTED_IDENTIFIER.test(block.text);

  if (block.text.length < MIN_REQUIREMENT_LENGTH && !structured && !namesIdentifier) {
    return false;
  }

  if (structured) return true;

  return namesIdentifier || REQUIREMENT_SIGNALS.some((pattern) => pattern.test(block.text));
}

/**
 * Signs that only part of a statement survived the parser.
 *
 * These are reported, never repaired: the missing half cannot be recovered
 * without inventing it, so the reviewer is told where to look instead.
 */
const FRAGMENT_RULES = [
  {
    pattern: /^[\p{Ll}]/u,
    note: 'Starts mid-sentence, so the condition this outcome depends on may be missing from the extracted text.',
  },
];

function detectFragments(block) {
  if (block.kind === 'table-row') return [];

  const notes = FRAGMENT_RULES.filter((rule) => rule.pattern.test(block.text)).map(
    (rule) => rule.note
  );

  if (block.text.length < MIN_REQUIREMENT_LENGTH) {
    notes.push(
      'Unusually short for a requirement, so part of the source sentence may be missing. Check it against the document.'
    );
  }

  return notes;
}

export function categorize(text) {
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(text)) return rule.category;
  }
  return 'Functional Behavior';
}

export function detectAmbiguities(text) {
  return AMBIGUITY_RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.note);
}

/** First clause of the requirement, used as a short handle in review. */
function buildTitle(block) {
  if (block.kind === 'table-row' && block.table?.cells?.length) {
    const first = block.table.cells.find(Boolean);
    if (first && first.length <= MAX_TITLE_LENGTH) return first;
  }

  const sentence = block.text.split(/(?<=[.!?])\s+/)[0] ?? block.text;
  if (sentence.length <= MAX_TITLE_LENGTH) return sentence.replace(/[.:;]$/, '');

  const clipped = sentence.slice(0, MAX_TITLE_LENGTH);
  const lastSpace = clipped.lastIndexOf(' ');
  return `${clipped.slice(0, lastSpace > 40 ? lastSpace : MAX_TITLE_LENGTH)}...`;
}

/**
 * The part of a document a block's wording belongs to, for deduplication.
 *
 * Identical text is only the same statement when it sits in the same place. A
 * PRD that writes one scenario per section repeats its branch sentences word for
 * word - "IF ACTIVE, then send the transaction to the designated switching" -
 * and each occurrence is a different branch of a different scenario. Keyed by
 * text alone, every one after the first was dropped: 29 branch sentences of the
 * sanitized Routing PRD vanished from the fallback, with no warning.
 *
 * The context is the heading OCCURRENCE a block sits under, counted as the
 * blocks go by, not the heading's wording: two scenarios can be filed under
 * headings that read the same (the parser makes "SYS" a heading on more than one
 * page), and merging them by name would lose a branch the same way. A format
 * without heading blocks gives its sheet or section instead. With none of these
 * there is no evidence that two occurrences are one statement, so the answer is
 * null and nothing is merged: a repeated requirement is visible, a merged one is
 * not.
 */
function dedupContext(block, headingsSeen) {
  if (headingsSeen > 0) return `heading:${headingsSeen}`;
  if (block.sheet) return `sheet:${block.sheet}`;
  if (block.section) return `section:${block.section}`;
  return null;
}

/**
 * Turns parsed blocks into requirements.
 *
 * @param {Array<{documentId: string, blocks: object[]}>} parsedDocuments  in upload order
 * @returns {{requirements: object[], skipped: number}}
 */
export function buildRequirements(parsedDocuments) {
  const requirements = [];
  let skipped = 0;
  let sequence = 0;

  // Document order then block order, so the same upload always produces the
  // same REQ numbers.
  for (const parsed of parsedDocuments) {
    const seenText = new Set();
    let headingsSeen = 0;

    for (const block of parsed.blocks) {
      if (block.kind === 'heading') headingsSeen += 1;

      if (isNoise(block)) {
        skipped += 1;
        continue;
      }

      if (!isRequirementCandidate(block)) {
        skipped += 1;
        continue;
      }

      // A header or footer repeated on every page of one section is the same
      // statement, not a second requirement. The same words in another section
      // are another requirement (see dedupContext).
      const context = dedupContext(block, headingsSeen);
      if (context !== null) {
        const key = `${context}\u0000${block.text.toLowerCase()}`;
        if (seenText.has(key)) {
          skipped += 1;
          continue;
        }
        seenText.add(key);
      }

      sequence += 1;
      requirements.push({
        requirement_id: formatSequentialId(ID_PREFIX.requirement, sequence),
        title: buildTitle(block),
        description: block.text,
        category: categorize(block.text),
        source_references: [buildSourceReference(block, parsed.documentId)],
        ambiguities: [...detectAmbiguities(block.text), ...detectFragments(block)],
        conflicts: [],
      });
    }
  }

  return { requirements, skipped };
}
