/**
 * Stable identity for every piece of text a document gave up.
 *
 * The parsers already produce blocks - a paragraph, a heading, a table row -
 * carrying their own page, section and geometry. What they did not have was a
 * name, and a name is what makes it possible to ask a model which blocks belong
 * together without letting it tell us what they say.
 *
 *   DOC-001-B001, DOC-001-B002, ...
 *
 * Assigned here, by position, before anything else sees them. The model
 * receives these ids and returns them; the system looks the text back up. That
 * is the whole trick: a model cannot fabricate a source reference it was never
 * allowed to write, and a paraphrase cannot become the requirement body because
 * the body is never taken from the reply.
 *
 * Ids are ephemeral, like everything else here. They are stable within one
 * request - same upload, same ids - and mean nothing afterwards.
 */

/** Long enough for a real document, short enough to keep prompts cheap. */
const MAX_QUOTE_LENGTH = 300;

/**
 * Assigns ids to every parsed block, in document then block order.
 *
 * Every block of the DOCUMENT is numbered, not just the ones that look like
 * requirements: the model has to see the background section and the synthetic
 * example table to recognise them as such and say so.
 *
 * An image region is not a block of the document. It is the parser's note about
 * content it did NOT read - "[Image on page 6 ... was not read]" - written in
 * this system's words. Numbered, it could be cited, and a cited block's text
 * becomes requirement description verbatim: on the real PRD that note reached
 * Gemini #2 as source text inside REQ-011 and derived an obligation no test case
 * could ever cover. It stays what it is - provenance for the
 * UNREAD_IMAGE_CONTENT warning, which extraction builds from the parser output
 * directly - and is never content. A human-verified transcription is a
 * different kind (image_transcription) and is numbered like any other block.
 *
 * @param {Array<{documentId: string, blocks: object[]}>} parsedDocuments
 * @returns {{blocks: object[], byId: Map<string, object>}}
 */
export function assignBlockIds(parsedDocuments) {
  const blocks = [];
  const byId = new Map();

  for (const parsed of parsedDocuments ?? []) {
    let sequence = 0;

    for (const block of parsed.blocks ?? []) {
      if (block.kind === 'image_region') continue;

      sequence += 1;
      const entry = {
        ...block,
        source_block_id: `${parsed.documentId}-B${String(sequence).padStart(3, '0')}`,
        document_id: parsed.documentId,
      };

      blocks.push(entry);
      byId.set(entry.source_block_id, entry);
    }
  }

  return { blocks, byId };
}

/**
 * Where a block came from, in the shape the canonical model expects.
 *
 * Built here and only here, from the parser's own metadata. Nothing downstream
 * - and no model - ever writes one of these.
 */
export function buildSourceReference(block, documentId = block.document_id) {
  return {
    document_id: documentId,
    page: block.page ?? null,
    section: block.sheet
      ? `${block.sheet}${block.cell ? ` ${block.cell}` : ''}`
      : (block.section ?? null),
    // The source's own words, kept verbatim so a reviewer can check the
    // requirement against what the document actually said.
    quote:
      block.text.length > MAX_QUOTE_LENGTH
        ? `${block.text.slice(0, MAX_QUOTE_LENGTH - 3)}...`
        : block.text,
  };
}

/**
 * The verbatim text of a group of blocks, in document order.
 *
 * This is what becomes a requirement's description. It is a join of strings the
 * parser produced - no summarising, no reordering, no cleaning up - because the
 * description is the evidence a reviewer checks the test cases against, and a
 * tidied version of the evidence is not evidence.
 */
export function textOf(blocks) {
  return blocks
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/**
 * Acceptance criteria, reconstructed from the blocks' own markers.
 *
 * Only what the wording states. A block beginning GIVEN is a given, one
 * beginning THEN is an outcome, and a bulleted line following a THEN is another
 * outcome - which is the shape that used to be lost, because the bullets were
 * separate blocks and nothing joined them back to the THEN above.
 *
 * Returns null when the document does not write in this form, which is most of
 * the time and is not a failure.
 */
const GIVEN = /^\s*(?:GIVEN|DIBERIKAN)\b[:\s]*/i;
const WHEN = /^\s*(?:WHEN|KETIKA|SAAT|APABILA)\b[:\s]*/i;
const THEN = /^\s*(?:THEN|MAKA)\b[:\s]*/i;
const BULLET = /^\s*[-•*–—]\s+/;

export function reconstructCriteria(blocks) {
  const given = [];
  const when = [];
  const then = [];
  let inThen = false;

  for (const block of blocks) {
    for (const line of String(block.text ?? '').split(/\n+/)) {
      const text = line.trim();
      if (!text) continue;

      if (GIVEN.test(text)) {
        given.push(text.replace(GIVEN, '').trim());
        inThen = false;
      } else if (WHEN.test(text)) {
        when.push(text.replace(WHEN, '').trim());
        inThen = false;
      } else if (THEN.test(text)) {
        then.push(text.replace(THEN, '').trim());
        inThen = true;
      } else if (inThen && BULLET.test(text)) {
        // A bullet under a THEN is one of its outcomes. This is the line that
        // used to disappear: several THEN bullets are several obligations, and
        // treating them as loose prose lost all but the first.
        then.push(text.replace(BULLET, '').trim());
      } else if (!BULLET.test(text)) {
        inThen = false;
      }
    }
  }

  const criteria = {
    given: given.filter(Boolean),
    when: when.filter(Boolean),
    then: then.filter(Boolean),
  };

  return criteria.given.length + criteria.when.length + criteria.then.length > 0 ? criteria : null;
}

/** Ceiling on what one structuring call carries, so a large upload stays affordable. */
export const PROMPT_LIMITS = {
  maxBlocks: 400,
  maxChars: 120000,
  maxBlockChars: 1200,
};

/**
 * Reduces blocks to what the structuring call needs, within a budget.
 *
 * Text is truncated per block rather than dropped wholesale, and the cut is
 * marked, so a long table does not silently push the end of the document out of
 * the prompt. What is left out entirely is reported by the caller.
 *
 * @returns {{sent: object[], omitted: number}}
 */
export function blocksForPrompt(blocks, limits = PROMPT_LIMITS) {
  const sent = [];
  let characters = 0;

  for (const block of blocks) {
    if (sent.length >= limits.maxBlocks || characters >= limits.maxChars) break;

    const full = String(block.text ?? '');
    const text =
      full.length > limits.maxBlockChars
        ? `${full.slice(0, limits.maxBlockChars)} [...truncated]`
        : full;

    characters += text.length;
    sent.push({
      source_block_id: block.source_block_id,
      document_id: block.document_id,
      kind: block.kind,
      page: block.page ?? null,
      section: block.section ?? null,
      text,
    });
  }

  return { sent, omitted: blocks.length - sent.length };
}
