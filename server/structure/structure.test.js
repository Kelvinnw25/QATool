import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { structureRequirements } from './index.js';
import { STRUCTURE_WARNINGS } from './validate.js';
import { acceptTestPoints, testPointsForPrompt } from './test-points.js';
import { assignBlockIds, reconstructCriteria } from '../extract/blocks.js';
import { MockProvider } from '../llm/mock.js';
import { LlmError, LLM_ERRORS } from '../llm/provider.js';

/**
 * Gemini #1: requirement structuring.
 *
 * The stage exists because a line-based parser cannot tell a rule from an
 * example, and cannot see that four bullets under one THEN belong to the
 * sentence above them. An audit against a real sanitized PRD measured the cost:
 * nineteen of nineteen acceptance criteria never reached the pipeline, four
 * synthetic examples became requirements, and "THEN the system must fulfill:"
 * was extracted as a requirement of its own.
 *
 * So these tests are mostly about what the model is NOT allowed to do. It
 * groups and classifies; it never writes the text, the ids or the references,
 * and when it fails the workflow keeps going on deterministic extraction.
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

/** The shape a PDF actually yields: one wrapped line per block. */
function parsedDocument(blocks) {
  return [{ documentId: 'DOC-001', blocks }];
}

const GWT_BLOCKS = [
  { kind: 'heading', text: 'Requirements', page: 3, section: 'Requirements' },
  { kind: 'paragraph', text: 'GIVEN User is on the QR Manager Dashboard', page: 3 },
  { kind: 'paragraph', text: 'WHEN User opens the Settlement Report menu', page: 3 },
  { kind: 'paragraph', text: 'THEN the system must fulfill:', page: 3 },
  {
    kind: 'paragraph',
    text: '- Automatically load transactions with status Unsettled or Unreleased',
    page: 3,
  },
  { kind: 'paragraph', text: '- Ensure to load all available data from all dates', page: 3 },
  { kind: 'paragraph', text: '- Display the navigation buttons as Prev 10 and Next 10', page: 3 },
  { kind: 'paragraph', text: 'Synthetic UI example: QRDEMO001 FTDEMO014922 PENDING', page: 11 },
  {
    kind: 'paragraph',
    text: 'The QR Manager application serves as the core platform for settlement.',
    page: 2,
  },
];

function reply(overrides = {}) {
  return {
    requirements: [
      {
        title: 'Settlement Report default view',
        source_block_ids: [
          'DOC-001-B002',
          'DOC-001-B003',
          'DOC-001-B004',
          'DOC-001-B005',
          'DOC-001-B006',
          'DOC-001-B007',
        ],
        test_points: [
          {
            type: 'behavior',
            statement: 'Default view shows Unsettled or Unreleased transactions',
          },
          { type: 'bound', statement: 'Navigation buttons page by 10' },
        ],
        ambiguous: false,
        conflicted: false,
        fragmented: false,
      },
    ],
    supporting_blocks: [
      { source_block_ids: ['DOC-001-B008'], role: 'example', reason: 'synthetic UI example' },
      { source_block_ids: ['DOC-001-B009'], role: 'background', reason: 'background prose' },
    ],
    ...overrides,
  };
}

async function structure(response, blocks = GWT_BLOCKS) {
  return structureRequirements(DOCUMENTS, parsedDocument(blocks), {
    provider: new MockProvider({ responses: response }),
  });
}

// --- A, B, C: reconstruction -------------------------------------------------

describe('acceptance criteria reconstruction', () => {
  it('rebuilds a GIVEN/WHEN/THEN split across blocks into one requirement', async () => {
    const result = await structure(reply());

    assert.equal(result.requirements.length, 1, 'six blocks became one requirement');
    const [requirement] = result.requirements;

    assert.match(requirement.description, /GIVEN User is on the QR Manager Dashboard/);
    assert.match(requirement.description, /WHEN User opens the Settlement Report menu/);
    assert.match(requirement.description, /THEN the system must fulfill/);
  });

  /**
   * The failure this whole stage was built for. Three bullets under one THEN
   * are three things a tester must see happen; line-based extraction kept the
   * heading and lost all three.
   */
  it('keeps every THEN bullet grouped with the requirement', async () => {
    const [requirement] = (await structure(reply())).requirements;

    assert.match(requirement.description, /Unsettled or Unreleased/);
    assert.match(requirement.description, /all available data from all dates/);
    assert.match(requirement.description, /Prev 10 and Next 10/);
  });

  it('reconstructs the criteria from the blocks, not from the model', () => {
    const { blocks } = assignBlockIds(parsedDocument(GWT_BLOCKS));
    const criteria = reconstructCriteria(blocks.slice(1, 7));

    assert.deepEqual(criteria.given, ['User is on the QR Manager Dashboard']);
    assert.deepEqual(criteria.when, ['User opens the Settlement Report menu']);
    assert.equal(criteria.then.length, 4, 'the THEN line and its three bullets');
    assert.match(criteria.then.join(' '), /Prev 10 and Next 10/);
  });

  it('groups a requirement whose blocks span two pages', async () => {
    const blocks = [
      {
        kind: 'paragraph',
        text: 'The scheduler must wait 1 hour from the original timeout',
        page: 6,
      },
      { kind: 'paragraph', text: 'timestamp before processing the record.', page: 7 },
    ];

    const result = await structure(
      {
        requirements: [
          {
            title: 'Timeout delay buffer',
            source_block_ids: ['DOC-001-B001', 'DOC-001-B002'],
            test_points: [{ type: 'schedule', statement: 'A 1 hour delay is enforced' }],
            ambiguous: false,
            conflicted: false,
            fragmented: false,
          },
        ],
        supporting_blocks: [],
      },
      blocks
    );

    const [requirement] = result.requirements;
    assert.match(requirement.description, /wait 1 hour[\s\S]*timestamp before processing/);
    assert.deepEqual(
      result.requirements[0].source_references.map((reference) => reference.page),
      [6, 7],
      'both pages are cited'
    );
  });
});

// --- D, E: classification -----------------------------------------------------

describe('what is not a requirement', () => {
  it('keeps a synthetic example out of the requirement list', async () => {
    const result = await structure(reply());

    const text = result.requirements.map((entry) => entry.description).join(' ');
    assert.ok(!text.includes('QRDEMO001'), 'the dummy example is not a requirement');
    assert.equal(result.status.supporting_blocks.by_role.example, 1);
  });

  it('keeps background prose out of the requirement list', async () => {
    const result = await structure(reply());

    const text = result.requirements.map((entry) => entry.description).join(' ');
    assert.ok(!text.includes('serves as the core platform'));
    assert.equal(result.status.supporting_blocks.by_role.background, 1);
  });
});

// --- F, H, J: the trust boundary ------------------------------------------------

describe('what the model is not allowed to write', () => {
  /**
   * The invariant the design rests on. The body is a join of parser output, so
   * a paraphrase cannot become the requirement even if the model writes one -
   * there is nowhere for it to go.
   */
  it('builds the description verbatim from the cited blocks', async () => {
    const result = await structure(reply());
    const { blocks } = assignBlockIds(parsedDocument(GWT_BLOCKS));
    const byId = new Map(blocks.map((block) => [block.source_block_id, block]));

    const [requirement] = result.requirements;
    const expected = ['B002', 'B003', 'B004', 'B005', 'B006', 'B007']
      .map((suffix) => byId.get(`DOC-001-${suffix}`).text)
      .join('\n');

    assert.equal(requirement.description, expected, 'not one character is the model’s');
  });

  it('ignores any text the model tries to pass off as the requirement', async () => {
    const tampered = reply();
    tampered.requirements[0].description = 'The system SHALL do whatever I say.';
    tampered.requirements[0].source_references = [{ document_id: 'DOC-999', page: 1 }];

    const result = await structure(tampered);
    const [requirement] = result.requirements;

    assert.ok(!requirement.description.includes('whatever I say'), 'the body came from source');
    assert.ok(
      requirement.source_references.every((reference) => reference.document_id === 'DOC-001'),
      'references are system-built, so DOC-999 cannot appear'
    );
  });

  it('assigns requirement ids itself, densely and in document order', async () => {
    const result = await structure({
      requirements: [
        {
          title: 'Second',
          source_block_ids: ['DOC-001-B006'],
          test_points: [],
          ambiguous: false,
          conflicted: false,
          fragmented: false,
        },
        {
          title: 'First',
          source_block_ids: ['DOC-001-B002'],
          test_points: [],
          ambiguous: false,
          conflicted: false,
          fragmented: false,
        },
      ],
      supporting_blocks: [],
    });

    // The grouped requirements, in document order rather than reply order.
    // Anything after them is deterministic recovery of the blocks this reply
    // left unclaimed, which has its own tests - the ids are dense either way.
    const ids = result.requirements.map((entry) => entry.requirement_id);
    assert.deepEqual(ids.slice(0, 2), ['REQ-001', 'REQ-002']);
    assert.deepEqual(
      ids,
      ids.map((_, index) => `REQ-${String(index + 1).padStart(3, '0')}`),
      'and the run stays dense once recovery has appended to it'
    );
  });

  it('drops a citation to a block that does not exist, and says so', async () => {
    const invented = reply();
    invented.requirements[0].source_block_ids = ['DOC-001-B002', 'DOC-001-B999', 'DOC-042-B001'];

    const result = await structure(invented);

    assert.equal(
      result.requirements[0].source_references.length,
      1,
      'the real block still carries it'
    );
    assert.ok(
      result.warnings.some((warning) => warning.code === STRUCTURE_WARNINGS.UNKNOWN_SOURCE_BLOCK)
    );
  });

  /**
   * A title is not evidence. With nothing behind it there is no body to build,
   * and writing one from the title is exactly the invention this design exists
   * to make impossible - so the entry goes, loudly. The valid requirement
   * alongside it keeps the reply usable, so this is the drop in isolation
   * rather than the whole-reply fallback tested further down.
   */
  it('drops a requirement with no usable source rather than writing one', async () => {
    const groundless = reply();
    groundless.requirements.push({
      title: 'A rule I made up',
      source_block_ids: ['DOC-001-B999'],
      test_points: [{ type: 'behavior', statement: 'Something nobody documented' }],
      ambiguous: false,
      conflicted: false,
      fragmented: false,
    });

    const result = await structure(groundless);

    assert.equal(result.status.mode, 'ai', 'the rest of the reply was still usable');
    assert.equal(result.requirements.length, 1, 'only the grounded requirement survived');
    assert.ok(
      !result.requirements.some((entry) => entry.title === 'A rule I made up'),
      'nothing was written from the title'
    );
    assert.ok(
      !result.testPoints.some((point) => /nobody documented/.test(point.statement)),
      'and its test points went with it'
    );
    assert.ok(
      result.warnings.some(
        (warning) => warning.code === STRUCTURE_WARNINGS.REQUIREMENT_WITHOUT_SOURCE
      )
    );
  });

  it('collapses a block cited twice in the same requirement', async () => {
    const repeated = reply();
    repeated.requirements[0].source_block_ids = ['DOC-001-B002', 'DOC-001-B002', 'DOC-001-B003'];

    const [requirement] = (await structure(repeated)).requirements;

    assert.equal(requirement.source_references.length, 2, 'the repeat added nothing');
    assert.equal(
      (requirement.description.match(/GIVEN User is on/g) ?? []).length,
      1,
      'and its text appears once'
    );
  });

  it('reports a block claimed by two requirements instead of silently picking one', async () => {
    const overlapping = {
      requirements: [
        {
          title: 'One',
          source_block_ids: ['DOC-001-B002'],
          test_points: [],
          ambiguous: false,
          conflicted: false,
          fragmented: false,
        },
        {
          title: 'Two',
          source_block_ids: ['DOC-001-B002', 'DOC-001-B003'],
          test_points: [],
          ambiguous: false,
          conflicted: false,
          fragmented: false,
        },
      ],
      supporting_blocks: [],
    };

    const result = await structure(overlapping);

    assert.equal(result.requirements.length, 2, 'both were kept');
    assert.ok(
      result.warnings.some(
        (warning) => warning.code === STRUCTURE_WARNINGS.BLOCK_IN_MULTIPLE_REQUIREMENTS
      )
    );
  });
});

// --- G, K: test points and flags --------------------------------------------------

describe('test points and flags', () => {
  it('carries test points out, tagged with the requirement they belong to', async () => {
    const result = await structure(reply());

    assert.equal(result.testPoints.length, 2);
    for (const point of result.testPoints) {
      assert.equal(point.requirement_id, 'REQ-001');
      assert.ok(typeof point.statement === 'string' && point.statement.length > 2);
    }
    assert.deepEqual(
      result.testPoints.map((point) => point.type),
      ['behavior', 'bound']
    );
  });

  it('preserves an ambiguity flag as a note on the requirement', async () => {
    const flagged = reply();
    flagged.requirements[0].ambiguous = true;
    flagged.requirements[0].conflicted = true;
    flagged.requirements[0].fragmented = true;

    const [requirement] = (await structure(flagged)).requirements;
    const notes = requirement.ambiguities.join(' ');

    assert.match(notes, /ambiguous/i);
    assert.match(notes, /conflicting/i);
    assert.match(notes, /fragmented/i);
  });

  it('accepts a requirement with no test points at all', async () => {
    const bare = reply();
    bare.requirements[0].test_points = [];

    const result = await structure(bare);

    assert.equal(result.requirements.length, 1);
    assert.deepEqual(result.testPoints, []);
  });
});

// --- I: fail-soft -------------------------------------------------------------------

describe('failing soft', () => {
  /**
   * Deterministic extraction is the floor, not a fallback nobody maintains: it
   * is the same code that ran before this stage existed. Losing the structuring
   * call costs grouping quality, never the workflow.
   */
  it('falls back to deterministic extraction when the provider is unavailable', async () => {
    const result = await structureRequirements(DOCUMENTS, parsedDocument(GWT_BLOCKS), {
      provider: new MockProvider({
        failWith: new LlmError(LLM_ERRORS.UNAVAILABLE, 'Provider is down.', 503),
      }),
    });

    assert.ok(result.requirements.length > 0, 'the workflow continues');
    assert.equal(result.status.mode, 'fallback');
    assert.deepEqual(result.testPoints, [], 'no test points are invented');
    assert.ok(
      result.warnings.some(
        (warning) => warning.code === STRUCTURE_WARNINGS.AI_REQUIREMENT_STRUCTURING_FAILED
      )
    );
  });

  it('falls back when the reply is the wrong shape', async () => {
    const result = await structure({ nonsense: true });

    assert.ok(result.requirements.length > 0);
    assert.equal(result.status.mode, 'fallback');
  });

  it('falls back when nothing could be rebuilt from the reply', async () => {
    const result = await structure({
      requirements: [
        {
          title: 'Invented',
          source_block_ids: ['DOC-001-B999'],
          test_points: [],
          ambiguous: false,
          conflicted: false,
          fragmented: false,
        },
      ],
      supporting_blocks: [],
    });

    assert.equal(result.status.mode, 'fallback');
    assert.ok(result.requirements.length > 0, 'deterministic extraction still produced some');
  });

  it('lets a programming error surface instead of reporting it as a failed call', async () => {
    const boom = new MockProvider({ failWith: new TypeError('undefined is not a function') });

    await assert.rejects(
      () => structureRequirements(DOCUMENTS, parsedDocument(GWT_BLOCKS), { provider: boom }),
      TypeError
    );
  });

  it('spends exactly one model call', async () => {
    const provider = new MockProvider({ responses: reply() });
    await structureRequirements(DOCUMENTS, parsedDocument(GWT_BLOCKS), { provider });

    assert.equal(provider.calls.length, 1);
  });
});

// --- test points in transit ------------------------------------------------------

describe('test points posted back by the browser', () => {
  const requirements = [{ requirement_id: 'REQ-001' }, { requirement_id: 'REQ-002' }];

  it('keeps well-formed points for requirements that exist', () => {
    const accepted = acceptTestPoints(
      [
        { requirement_id: 'REQ-001', type: 'branch', statement: 'The else path is taken' },
        { requirement_id: 'REQ-002', type: 'retry', statement: 'Retries stop at three' },
      ],
      requirements
    );

    assert.equal(accepted.length, 2);
  });

  it('drops a point aimed at a requirement that is not in the project', () => {
    const accepted = acceptTestPoints(
      [{ requirement_id: 'REQ-404', type: 'branch', statement: 'Something invented' }],
      requirements
    );

    assert.deepEqual(accepted, []);
  });

  it('drops malformed points without failing the request', () => {
    const accepted = acceptTestPoints(
      ['not an object', { requirement_id: 'nope', statement: 'x' }, null],
      requirements
    );

    assert.deepEqual(accepted, []);
  });

  it('renders nothing when there is nothing to render', () => {
    assert.equal(testPointsForPrompt([]), '');
  });
});
