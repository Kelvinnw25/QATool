import { formatSequentialId, ID_PREFIX } from '../lib/ids.js';
import { buildSourceReference, reconstructCriteria, textOf } from '../extract/blocks.js';
import { categorize, detectAmbiguities } from '../extract/requirements.js';

/**
 * Structural validation of the structuring reply, and reconstruction from source.
 *
 * The distinction this module rests on:
 *
 *   structural  can this be used at all? Does every cited block exist, is
 *               anything duplicated, is the shape sane. Machine-checkable,
 *               cheap, and the only thing enforced here.
 *   semantic    is this grouping right, is that really an example. Not checked.
 *               Deliberately. There is no exact-quote gate, no paraphrase
 *               comparison and no similarity score, because the model is never
 *               allowed to write the text those checks would compare - the
 *               body is rebuilt from the blocks, so it is verbatim by
 *               construction rather than by inspection.
 *
 * A questionable classification is kept and flagged. Only a citation that
 * cannot be resolved is dropped, because there is nothing behind it to use.
 */

export const STRUCTURE_WARNINGS = {
  UNKNOWN_SOURCE_BLOCK: 'UNKNOWN_SOURCE_BLOCK',
  DUPLICATE_SOURCE_BLOCK: 'DUPLICATE_SOURCE_BLOCK',
  REQUIREMENT_WITHOUT_SOURCE: 'REQUIREMENT_WITHOUT_SOURCE',
  BLOCK_IN_MULTIPLE_REQUIREMENTS: 'BLOCK_IN_MULTIPLE_REQUIREMENTS',
  AI_REQUIREMENT_STRUCTURING_FAILED: 'AI_REQUIREMENT_STRUCTURING_FAILED',
  SOURCE_TRUNCATED: 'SOURCE_TRUNCATED',
};

/** A requirement body longer than this is a grouping mistake, not a requirement. */
const MAX_DESCRIPTION = 5000;

/**
 * Turns a validated reply into requirements built from the source.
 *
 * Every field that carries meaning is taken from the blocks, not the reply:
 * the description is their text joined verbatim, the source references are
 * built from their parser metadata, the category is derived from the text, and
 * the id is assigned here in document order. What survives from the model is
 * the grouping itself, a title, the flags and the test points - guidance, all
 * of it clearly labelled as such.
 *
 * @param {object} response          parsed against structureResponse
 * @param {Map<string, object>} byId every known block, by source_block_id
 * @returns {{requirements: object[], testPoints: object[], warnings: object[], claimed: Set<string>}}
 */
export function reconstructRequirements(response, byId) {
  const requirements = [];
  const testPoints = [];
  const warnings = [];
  const claimed = new Map();
  let sequence = 0;

  for (const [index, entry] of (response.requirements ?? []).entries()) {
    const seen = new Set();
    const blocks = [];
    const unknown = [];

    for (const blockId of entry.source_block_ids) {
      if (!byId.has(blockId)) {
        unknown.push(blockId);
        continue;
      }
      // A block cited twice in one requirement adds nothing and would repeat
      // its text in the body. Dropped quietly - it is a duplicate, not a loss.
      if (seen.has(blockId)) continue;
      seen.add(blockId);
      blocks.push(byId.get(blockId));
    }

    if (unknown.length > 0) {
      warnings.push({
        code: STRUCTURE_WARNINGS.UNKNOWN_SOURCE_BLOCK,
        document_id: null,
        message: `Requirement ${index + 1} cited ${unknown.length} source block(s) that do not exist (${unknown.slice(0, 3).join(', ')}). They were dropped; nothing was invented to replace them.`,
      });
    }

    // Nothing to rebuild from. The entry is not kept: a requirement whose body
    // would have to be written by us is exactly what this design refuses.
    if (blocks.length === 0) {
      warnings.push({
        code: STRUCTURE_WARNINGS.REQUIREMENT_WITHOUT_SOURCE,
        document_id: null,
        message: `Requirement ${index + 1} ("${entry.title}") cited no usable source block, so it was dropped rather than written from the title.`,
      });
      continue;
    }

    for (const block of blocks) {
      if (claimed.has(block.source_block_id)) {
        warnings.push({
          code: STRUCTURE_WARNINGS.BLOCK_IN_MULTIPLE_REQUIREMENTS,
          document_id: block.document_id,
          message: `${block.source_block_id} was grouped into more than one requirement. Both were kept; check whether they are really the same rule.`,
        });
      }
      claimed.set(block.source_block_id, true);
    }

    // Document order, so the same upload always produces the same REQ numbers
    // whatever order the model happened to list them in.
    blocks.sort((left, right) => left.source_block_id.localeCompare(right.source_block_id));

    const description = textOf(blocks).slice(0, MAX_DESCRIPTION);
    if (description.length === 0) continue;

    sequence += 1;
    const requirementId = formatSequentialId(ID_PREFIX.requirement, sequence);

    const flags = [];
    if (entry.ambiguous)
      flags.push(
        'Marked ambiguous during structuring: the expected behaviour is not clearly stated.'
      );
    if (entry.conflicted)
      flags.push('Marked as conflicting with other source text during structuring.');
    if (entry.fragmented)
      flags.push(
        'Marked as fragmented: part of this requirement may be missing from the extracted text.'
      );

    requirements.push({
      requirement_id: requirementId,
      title: entry.title.slice(0, 300),
      description,
      category: categorize(description),
      source_references: blocks.map((block) => buildSourceReference(block)),
      ambiguities: [...detectAmbiguities(description), ...flags],
      conflicts: [],
    });

    for (const point of entry.test_points) {
      testPoints.push({
        requirement_id: requirementId,
        type: point.type,
        statement: point.statement,
      });
    }
  }

  return {
    requirements,
    testPoints,
    warnings,
    criteria: buildCriteriaIndex(response, byId, requirements),
    // Which blocks the grouping actually used. Recovery needs the complement
    // of this set, and only this function knows it.
    claimed: new Set(claimed.keys()),
  };
}

/**
 * The GIVEN/WHEN/THEN of each requirement, where the document writes that way.
 *
 * Derived from the blocks, not from the model, and only where the markers are
 * actually present. Used to make the generation prompt concrete; absent for
 * documents written as prose, which is most of them.
 */
function buildCriteriaIndex(response, byId, requirements) {
  const index = {};

  requirements.forEach((requirement, position) => {
    const entry = (response.requirements ?? [])[position];
    if (!entry) return;

    const blocks = entry.source_block_ids.map((id) => byId.get(id)).filter(Boolean);
    const criteria = reconstructCriteria(blocks);
    if (criteria) index[requirement.requirement_id] = criteria;
  });

  return index;
}

/**
 * Blocks the model classified as something other than a requirement.
 *
 * Kept as information, never as a deletion: extraction still knows every block,
 * and this only records why the structuring call set some aside. A reviewer who
 * disagrees can see what was left out and why.
 */
export function summariseSupporting(response, byId) {
  const counted = new Map();

  for (const entry of response.supporting_blocks ?? []) {
    for (const blockId of entry.source_block_ids) {
      if (!byId.has(blockId)) continue;
      counted.set(blockId, entry.role);
    }
  }

  const byRole = {};
  for (const role of counted.values()) byRole[role] = (byRole[role] ?? 0) + 1;

  return { total: counted.size, by_role: byRole };
}
