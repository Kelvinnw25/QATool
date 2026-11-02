import { z } from 'zod';

/** Trimmed, non-empty text. */
export const nonEmptyText = (max = 2000) =>
  z.string().trim().min(1, 'Must not be empty.').max(max, `Must be ${max} characters or fewer.`);

/** Trimmed text that is allowed to be empty; '' normalises to null. */
export const optionalText = (max = 2000) =>
  z
    .string()
    .trim()
    .max(max, `Must be ${max} characters or fewer.`)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .default(null);

/**
 * Abbreviations whose full stop does not end a sentence. Bank documents are
 * full of these - "PT. Bank Sinarmas", "e.g. BIC code" - and treating their
 * full stop as a sentence break would reject perfectly good one-liners.
 */
const ABBREVIATIONS =
  /^(?:e\.g|i\.e|etc|vs|cf|approx|no|fig|dr|mr|mrs|ms|prof|st|pt|cv|tbk|jr|sr)$/i;

/**
 * True when the text contains a sentence break, i.e. it is more than one
 * sentence.
 *
 * A break is a terminator followed by whitespace and the start of something
 * new. A trailing terminator is not a break, decimals are not breaks (no
 * whitespace follows the point), and neither abbreviations nor single-letter
 * initials count.
 */
export function hasMultipleSentences(value) {
  const text = String(value ?? '').trim();
  const breaks = /([.!?])\s+(?=[A-Z0-9"'(])/g;

  let match;
  while ((match = breaks.exec(text)) !== null) {
    const preceding = text.slice(0, match.index);
    const lastWord = /([A-Za-z.]+)$/.exec(preceding)?.[1] ?? '';

    if (ABBREVIATIONS.test(lastWord)) continue;
    if (/^[A-Z]$/.test(lastWord)) continue; // an initial, as in "J. Smith"

    return true;
  }

  return false;
}

/**
 * Optional text constrained to a single sentence.
 *
 * "Exactly one sentence" is a machine-checkable instruction, and one an LLM
 * reliably overruns, so it is checked rather than hoped for. Reported by
 * /api/validate; it does not block the XLSX export, which does not carry this
 * field.
 */
export const oneSentenceText = (max = 300) =>
  z
    .string()
    .trim()
    .max(max, `Must be ${max} characters or fewer.`)
    .refine((value) => value === '' || !hasMultipleSentences(value), {
      message: 'Must be exactly one sentence.',
    })
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .default(null);

/**
 * Where a piece of extracted information came from (PRD 7/19).
 *
 * `page` is null for DOCX, which has no fixed pagination - section carries the
 * traceability there instead. Recording the shortfall beats pretending to a
 * page number the format cannot supply.
 */
export const sourceReference = z
  .object({
    document_id: z
      .string()
      .trim()
      .regex(/^DOC-\d{3,}$/, 'Must reference a document as DOC-nnn.'),
    page: z.number().int().positive().nullable().default(null),
    section: optionalText(500),
    quote: optionalText(1000),
  })
  .strict();

export const sourceReferences = z.array(sourceReference).default([]);

/**
 * A non-blocking note attached to AI-produced content (PRD 10/15).
 * Warnings surface in review; they never modify approved QA content.
 *
 * `field` and `observed_value` are optional and carry the specifics a reviewer
 * needs when the note is about one value rather than the whole case: which
 * field is questionable, and what the model actually put there. Quoting the
 * observed value is the point - it is the evidence that nothing was rewritten
 * on the way through, and it lets the Results page show the real draft next to
 * the concern instead of a corrected version of it.
 */
export const warning = z
  .object({
    code: nonEmptyText(80),
    message: nonEmptyText(1000),
    field: optionalText(80),
    observed_value: optionalText(200),
  })
  .strict();

export const warnings = z.array(warning).default([]);
