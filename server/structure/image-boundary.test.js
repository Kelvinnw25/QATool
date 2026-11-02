import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { structureRequirements } from './index.js';
import { assignBlockIds } from '../extract/blocks.js';
import { deriveCoverageObligations } from '../scenario/obligations.js';
import { MockProvider } from '../llm/mock.js';

/**
 * The parser's note about an unread image is metadata, never content.
 *
 * An image_region block says, in this system's words, that a picture exists and
 * was not read. Line-based extraction always discarded it, but structuring
 * numbered every block, so Gemini #1 could cite it and its text was rebuilt
 * verbatim into a requirement. On the real PRD that is exactly what happened:
 * REQ-011 carried "[Image on page 6, 224x133pt, introduced by: ... was not
 * read]", Gemini #2 received it as source text, and it derived an obligation no
 * test case could cover - missed in ten runs of ten.
 *
 * A human-verified image_transcription is the opposite case and must still flow.
 */

const DOCUMENTS = [
  {
    document_id: 'DOC-001',
    filename: 'PRD QR Manager.pdf',
    document_type: 'PRD',
    status: 'Extracted',
    page_count: 12,
  },
];

const PLACEHOLDER =
  '[Image on page 6, 224x133pt, introduced by: "Report format to be generated as shown below:". Its content is not in the PDF text layer and was not read.]';

/** The block sequence the real PRD's page 6 yields, as the PDF parser emits it. */
const BLOCKS = [
  { kind: 'paragraph', text: 'GIVEN all transactions for D-1 have concluded', page: 5 },
  { kind: 'paragraph', text: 'WHEN the system clock reaches 03.00 AM', page: 5 },
  { kind: 'paragraph', text: 'THEN the system must fulfill:', page: 5 },
  {
    kind: 'paragraph',
    text: '- Generate the final report file in .txt format using a tilde ~ as the data delimiter',
    page: 5,
  },
  { kind: 'paragraph', text: '- Report format to be generated as shown below:', page: 6 },
  {
    kind: 'image_region',
    text: PLACEHOLDER,
    page: 6,
    lead_in: 'Report format to be generated as shown below:',
    width_pt: 224,
    height_pt: 133,
  },
];

/** A model that groups every block it was shown into one requirement. */
function greedy({ prompt }) {
  const ids = [...new Set(String(prompt).match(/DOC-001-B\d{3}/g) ?? [])];
  return {
    requirements: [
      {
        title: 'Auto-Generate Daily Settlement Report',
        source_block_ids: ids,
        test_points: [],
        ambiguous: false,
        conflicted: false,
        fragmented: false,
      },
    ],
    supporting_blocks: [],
  };
}

/** A model that claims nothing, leaving every block to deterministic recovery. */
const silent = () => ({ requirements: [], supporting_blocks: [] });

async function structure(respond, blocks = BLOCKS) {
  const provider = new MockProvider({ responses: respond });
  const result = await structureRequirements(DOCUMENTS, [{ documentId: 'DOC-001', blocks }], {
    provider,
  });
  return { result, prompt: provider.calls[0]?.prompt ?? '' };
}

const contentOf = (requirements) =>
  requirements
    .flatMap((requirement) => [
      requirement.title,
      requirement.description,
      ...requirement.source_references.map((reference) => reference.quote),
    ])
    .join('\n');

describe('an unread image region', () => {
  it('is never given a block id', () => {
    const { blocks, byId } = assignBlockIds([{ documentId: 'DOC-001', blocks: BLOCKS }]);

    assert.equal(blocks.length, BLOCKS.length - 1);
    assert.ok(blocks.every((block) => block.kind !== 'image_region'));
    assert.deepEqual(
      [...byId.keys()],
      ['DOC-001-B001', 'DOC-001-B002', 'DOC-001-B003', 'DOC-001-B004', 'DOC-001-B005'],
      'the ids of the real blocks stay contiguous'
    );
  });

  it('is never shown to the structuring model as text to group', async () => {
    const { prompt } = await structure(greedy);

    assert.doesNotMatch(prompt, /Image on page 6/);
  });

  it('cannot enter a requirement even when the model claims everything', async () => {
    const { result } = await structure(greedy);

    assert.ok(result.requirements.length > 0, 'the real blocks still form a requirement');
    assert.doesNotMatch(contentOf(result.requirements), /\[Image on page|was not read/);
    assert.match(contentOf(result.requirements), /Report format to be generated as shown below/);
  });

  it('cannot enter a requirement through deterministic recovery either', async () => {
    const { result } = await structure(silent);

    assert.doesNotMatch(contentOf(result.requirements), /\[Image on page|was not read/);
  });

  it('therefore derives no obligation', async () => {
    const { result } = await structure(greedy);
    const obligations = deriveCoverageObligations(result.requirements);

    assert.ok(
      obligations.every(
        (obligation) =>
          !/Image on page|was not read/.test(obligation.statement + obligation.source_basis)
      )
    );
  });
});

describe('a human-verified transcription', () => {
  it('is still numbered and can still become requirement content', async () => {
    const transcribed = [
      ...BLOCKS.slice(0, 5),
      {
        kind: 'image_transcription',
        text: 'Write TRX_DATE and SETTLEMENT_DATE in format DD-MMM-YY',
        page: 6,
        provenance: 'image_transcription',
        verified_by: 'A. Reviewer',
        transcribed_from: 'spec.pdf',
      },
    ];

    const { blocks } = assignBlockIds([{ documentId: 'DOC-001', blocks: transcribed }]);
    assert.ok(blocks.some((block) => block.kind === 'image_transcription'));

    const { result } = await structure(greedy, transcribed);
    assert.match(contentOf(result.requirements), /DD-MMM-YY/);
  });
});
