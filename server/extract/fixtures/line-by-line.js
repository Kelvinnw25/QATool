import { assignBlockIds } from '../blocks.js';
import { buildRequirements } from '../requirements.js';
import { parseDocuments } from '../parse.js';
import { structureParsed } from '../index.js';
import { MockProvider } from '../../llm/mock.js';

/**
 * TEST FIXTURE. Nothing under server/ imports this except tests (a test pins that).
 *
 * Many parser tests used to call `extractDocuments(files)` with no model and rely on
 * the deterministic extraction that ran when the model failed. That extraction is no
 * longer part of the pipeline: a failed structuring call fails the job. What those
 * tests are about is the PARSER - which blocks exist, which page and section they
 * carry, what a table row keeps - so they now ask a stand-in "model" that answers the
 * structuring call by citing exactly the blocks line-by-line selection picks, and run
 * the real structuring code on that answer.
 *
 * The stand-in is not a model and proves nothing about one. It exists so a parser
 * test reads parser output.
 */

/** The structuring answer that cites the blocks `buildRequirements` selects. */
export function lineByLineAnswer(parsedDocuments) {
  const requirements = [];

  for (const parsed of parsedDocuments) {
    const { blocks } = assignBlockIds([parsed]);
    const { requirements: selected } = buildRequirements([parsed]);

    // buildRequirements keeps block order and uses a block's own text as the
    // description, so a forward scan finds each selected block exactly.
    let cursor = 0;
    for (const requirement of selected) {
      while (cursor < blocks.length && blocks[cursor].text !== requirement.description) cursor += 1;
      if (cursor >= blocks.length) break;

      requirements.push({
        title: requirement.title,
        source_block_ids: [blocks[cursor].source_block_id],
        test_points: [],
        ambiguous: false,
        conflicted: false,
        // Line-by-line selection noticed a cut-off sentence; the structuring contract's
        // own flag for that is `fragmented`.
        fragmented: requirement.ambiguities.some((note) => /may be missing/.test(note)),
      });
      cursor += 1;
    }
  }

  return { requirements, supporting_blocks: [] };
}

/**
 * A structuring answer worked out from the prompt alone, for tests that reach the stage
 * through a route or a provider setting and so have no parsed documents in hand: one
 * requirement per block that is not a heading. Usable as a MockProvider response.
 */
export function eachBlockAnswer({ prompt }) {
  const listed = /\n(\[\n[\s\S]*?\n\])\n/.exec(String(prompt))?.[1];
  const blocks = listed ? JSON.parse(listed) : [];

  return {
    requirements: blocks
      .filter((block) => block.kind !== 'heading')
      .map((block) => ({
        title: String(block.text).slice(0, 80),
        source_block_ids: [block.source_block_id],
        test_points: [],
        ambiguous: false,
        conflicted: false,
        fragmented: false,
      })),
    supporting_blocks: [],
  };
}

/** `extractDocuments`, with the structuring call answered line by line. */
export async function extractLineByLine(files) {
  const parsed = await parseDocuments(files);
  const provider = new MockProvider({ responses: () => lineByLineAnswer(parsed.parsedDocuments) });
  return structureParsed(parsed, { provider });
}
