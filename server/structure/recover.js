import { formatSequentialId, ID_PREFIX } from '../lib/ids.js';
import { buildSourceReference, textOf } from '../extract/blocks.js';
import { categorize, detectAmbiguities } from '../extract/requirements.js';
import { deriveCoverageObligations } from '../scenario/obligations.js';

/**
 * Deterministic recovery of behaviour the structuring call set aside.
 *
 * Gemini #1 decides which blocks become requirements and which are background.
 * Everything downstream reads requirement text, so a block it does not cite
 * contributes no obligations, no test points and no coverage denominator - it
 * leaves the pipeline on a model's judgement, and only a count of it survives.
 *
 * That made the obligation universe a function of the grouping rather than of
 * the document, which is why repeated runs over one PRD covered different
 * things. Measured on the real PRD: 252 blocks, 194 grouped into requirements,
 * 57 called background. Among all 252, exactly 24 carry behaviour a detector
 * can read - the response mapping rows, the retry chain, the filter branches,
 * the Select All context. Whether each run tested those depended on which side
 * of that split the model happened to put them on.
 *
 * So the grouping keeps its job and loses its veto. A block the model set aside
 * is restored ONLY when the deterministic detectors read behaviour in it, which
 * is a claim about the document rather than about the model, and it is restored
 * as the source's own text: verbatim, contiguous, attributed to its own pages.
 *
 * What this is NOT:
 *
 *   not a second opinion on grouping   blocks the model DID group are untouched,
 *                                      and a recovered block is never moved into
 *                                      an existing requirement
 *   not invention                      the body is block text joined verbatim,
 *                                      exactly as reconstruction builds every
 *                                      other requirement
 *   not a quality claim                recovered requirements are flagged as
 *                                      recovered, so a reviewer can see that
 *                                      structuring disagreed
 */

/** A run of set-aside blocks shorter than this is a heading, not a behaviour. */
const MIN_RECOVERED_CHARS = 40;

/** A document that recovers more than this was not really structured at all. */
const MAX_RECOVERED_REQUIREMENTS = 10;

/**
 * Obligations per character a run must reach to count as stating behaviour.
 *
 * One per thousand characters, set from measurement rather than taste: on the
 * real PRD the genuine requirements scored 2.3 to 10.7, and the background
 * section that should never have been recovered scored 0.37. The floor sits an
 * order of magnitude clear of both.
 */
const MIN_OBLIGATION_DENSITY = 1 / 1000;

/** Matches the ceiling reconstruction puts on a requirement body. */
const MAX_DESCRIPTION = 5000;

export const RECOVERY_WARNING = 'BEHAVIOURAL_CONTENT_RECOVERED';

/**
 * Groups set-aside blocks into contiguous runs.
 *
 * Contiguity matters because behaviour is regularly stated across two adjacent
 * blocks - an IF on one line and its THEN on the next, a table header and the
 * row under it. Splitting those apart would lose the obligation as surely as
 * dropping them, so neighbours travel together.
 */
function contiguousRuns(blocks, claimed) {
  const runs = [];
  let current = null;

  blocks.forEach((block, index) => {
    if (claimed.has(block.source_block_id)) {
      current = null;
      return;
    }

    if (current && current.end === index - 1 && current.documentId === block.document_id) {
      current.blocks.push(block);
      current.end = index;
      return;
    }

    current = { documentId: block.document_id, blocks: [block], end: index };
    runs.push(current);
  });

  return runs;
}

/**
 * Names a recovered requirement from its own first line.
 *
 * Taken from the source rather than written here, for the same reason the body
 * is: a title we composed would be the one piece of a requirement that no
 * document said.
 */
function titleFor(text) {
  const first = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return (first ?? text).slice(0, 200);
}

/**
 * Restores set-aside blocks that demonstrably state behaviour.
 *
 * @param {object[]} blocks            every block, in document order
 * @param {Set<string>} claimed        source_block_ids already in a requirement
 * @param {number} startSequence       requirements already assigned REQ ids
 * @returns {{requirements: object[], warnings: object[], considered: number}}
 */
export function recoverBehaviouralBlocks(blocks, claimed, startSequence) {
  const requirements = [];
  const recovered = [];
  let sequence = startSequence;

  const runs = contiguousRuns(blocks ?? [], claimed ?? new Set());

  let overflow = 0;

  for (const run of runs) {
    const description = textOf(run.blocks).slice(0, MAX_DESCRIPTION);
    if (description.length < MIN_RECOVERED_CHARS) continue;

    // The whole test. A run is restored because the detectors read an
    // obligation in it, not because it is long or looks important - the same
    // standard the coverage denominator is built on, applied one stage earlier.
    const probe = [
      {
        requirement_id: 'REQ-001',
        title: '',
        description,
        category: 'Functional Behavior',
        source_references: [],
        ambiguities: [],
        conflicts: [],
      },
    ];
    const obligations = deriveCoverageObligations(probe);
    if (obligations.length === 0) continue;

    // A single hit inside a long passage is a mention, not a statement of
    // behaviour. Measured on the real PRD: the document's approval table,
    // background and objectives formed one 2,704-character run whose only
    // obligation came from an objective bullet saying the feature exists -
    // 0.37 obligations per thousand characters, where every genuine requirement
    // in the same document scored between 2.3 and 10.7. Recovering it produced a
    // 59-block "requirement" and one permanent coverage gap restating a
    // behaviour REQ-008 already owned in detail.
    if (obligations.length / description.length < MIN_OBLIGATION_DENSITY) continue;

    // Counted rather than broken out of. The ceiling exists so a badly
    // structured document cannot bury the requirement list, but a run silently
    // dropped here is the same silent loss this module was written to remove -
    // so what did not fit is reported instead.
    if (requirements.length >= MAX_RECOVERED_REQUIREMENTS) {
      overflow += 1;
      continue;
    }

    sequence += 1;
    requirements.push({
      requirement_id: formatSequentialId(ID_PREFIX.requirement, sequence),
      title: titleFor(description),
      description,
      category: categorize(description),
      source_references: run.blocks.map((block) => buildSourceReference(block)),
      ambiguities: [
        ...detectAmbiguities(description),
        'Recovered deterministically: structuring classified this text as background, but it ' +
          'states behaviour that coverage is measured over. Check whether it belongs with ' +
          'another requirement.',
      ],
      conflicts: [],
    });

    recovered.push({
      blocks: run.blocks.map((block) => block.source_block_id),
      obligations: obligations.length,
    });
  }

  if (requirements.length === 0) {
    return { requirements: [], warnings: [], considered: runs.length, overflow: 0 };
  }

  const blockCount = recovered.reduce((sum, entry) => sum + entry.blocks.length, 0);
  const obligationCount = recovered.reduce((sum, entry) => sum + entry.obligations, 0);

  return {
    requirements,
    warnings: [
      {
        code: RECOVERY_WARNING,
        document_id: null,
        message:
          `${blockCount} source block(s) were classified as background during structuring but state ` +
          `${obligationCount} testable behaviour(s), so they were restored as ` +
          `${requirements.length} requirement(s) (${requirements.map((entry) => entry.requirement_id).join(', ')}) ` +
          `rather than dropped. Their text is the document's own; the grouping is not, so check ` +
          `whether each belongs with a requirement above it.` +
          (overflow > 0
            ? ` A further ${overflow} passage(s) also state behaviour and did NOT fit: this document ` +
              `was barely structured at all, and the requirement list is incomplete.`
            : ''),
      },
    ],
    considered: runs.length,
    overflow,
  };
}
