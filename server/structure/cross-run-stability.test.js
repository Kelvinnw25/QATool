import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { structureRequirements } from './index.js';
import { RECOVERY_WARNING } from './recover.js';
import { MockProvider } from '../llm/mock.js';
import { deriveCoverageObligations } from '../scenario/obligations.js';

/**
 * Three identical runs over one document produced three different test suites.
 *
 * Not in size - that is expected and fine - but in what they tested. The
 * response mapping rows were covered twice and missing once; the Select All
 * context appeared in one run of three; the exact timeout codes appeared in two.
 * Nothing in the output said a behaviour had gone, because the coverage
 * denominator went with it.
 *
 * The cause is upstream of the generator. Obligations are derived from
 * requirement text, requirement text is the blocks Gemini #1 chose to cite, and
 * a block it calls background contributes nothing and is reported only as a
 * count. So the obligation universe was a function of one model's grouping
 * rather than of the document, and two runs could disagree about what the
 * document required.
 *
 * These fixtures are that disagreement, reduced: ONE block list, THREE
 * groupings of it, taken from what the three runs did.
 *
 *   RUN_1  every behavioural block grouped into a requirement
 *   RUN_2  the same behaviours, two requirements merged into one
 *   RUN_3  the mapping rows and the Select All context called background
 *
 * The property under test is set membership, never cardinality: the runs may
 * decompose differently, and only a behaviour that disappears is a defect.
 */

const DOCUMENTS = [
  {
    document_id: 'DOC-001',
    filename: 'PRD Settlement (synthetic).pdf',
    document_type: 'PRD',
    status: 'Extracted',
    page_count: 9,
  },
];

/**
 * One block per line, as a PDF yields them.
 *
 * Synthetic wording carrying the real shapes: a two-row response mapping, a
 * retry chain with a cap and a guard, two filter branches, a selection rule
 * that only means anything inside a stated action and page size, and prose that
 * states no behaviour at all.
 */
const BLOCKS = [
  { kind: 'heading', text: 'Settlement Release', page: 2, section: 'Release' }, // B001
  {
    kind: 'paragraph',
    text: 'Call Check Status to the core system via the gateway (mscore) to verify the actual state of the transaction.',
    page: 2,
  }, // B002
  {
    kind: 'paragraph',
    text: 'Y.ISO.RESPONSE:1:1="00" AND Y.MSG.RES:1:1="FT250430FK4S" -> Funds Transfer Success (transaction processed in core)',
    page: 2,
  }, // B003
  {
    kind: 'paragraph',
    text: 'Y.ISO.RESPONSE:1:1="01" AND Y.MSG.RES:1:1="Transaction Failed!" -> Transaction Not Found / Failed (FT is not recorded)',
    page: 2,
  }, // B004
  {
    kind: 'paragraph',
    text: 'IF the status check returns FAILED or NOT FOUND, then trigger retry Release Settlement to the gateway. The maximum number of retries is 3.',
    page: 3,
  }, // B005
  {
    kind: 'paragraph',
    text: 'IF the status remains unresolved (FAILED) after the 3rd retry attempt, then mark the transaction as permanently FAILED.',
    page: 3,
  }, // B006
  {
    kind: 'paragraph',
    text: 'Notes: Retry for Settlement Release is only performed when the status check response is FAILED and the retry attempt has not reached 3 times.',
    page: 3,
  }, // B007
  { kind: 'heading', text: 'Advance Search', page: 5, section: 'Search' }, // B008
  {
    kind: 'paragraph',
    text: 'IF the User pick Settled filter, then display all of the settled transactions.',
    page: 5,
  }, // B009
  {
    kind: 'paragraph',
    text: 'IF the User pick Unsettled filter, then display all of the unsettled transactions.',
    page: 5,
  }, // B010
  {
    kind: 'paragraph',
    text: 'WHEN the user clicks the Release action button (Settlement Type: HOLD), the transaction list is displayed.',
    page: 6,
  }, // B011
  {
    kind: 'paragraph',
    text: 'Notes: Select All only applies to transactions on the current active page, which displays a maximum of 10 rows.',
    page: 6,
  }, // B012
  {
    kind: 'paragraph',
    text: 'The QR Manager application serves as the core platform used by the settlement team.',
    page: 1,
  }, // B013
  {
    kind: 'paragraph',
    text: 'This document was reviewed by the Reconciliation and Technology teams.',
    page: 1,
  }, // B014
];

const id = (n) => `DOC-001-B${String(n).padStart(3, '0')}`;

function requirement(title, blockNumbers) {
  return {
    title,
    source_block_ids: blockNumbers.map(id),
    test_points: [{ type: 'behavior', statement: `${title} behaves as stated` }],
    ambiguous: false,
    conflicted: false,
    fragmented: false,
  };
}

function background(blockNumbers, reason) {
  return { source_block_ids: blockNumbers.map(id), role: 'background', reason };
}

/** Every behavioural block grouped. The run that covered the most. */
const RUN_1 = {
  requirements: [
    requirement('Status verification and response mapping', [2, 3, 4]),
    requirement('Settlement release retry', [5, 6, 7]),
    requirement('Advance Search filters', [9, 10]),
    requirement('Select All on the Release screen', [11, 12]),
  ],
  supporting_blocks: [background([1, 8, 13, 14], 'headings and background prose')],
};

/** Two requirements merged into one. Same behaviours, coarser grouping. */
const RUN_2 = {
  requirements: [
    requirement('Status verification, mapping and retry', [2, 3, 4, 5, 6, 7]),
    requirement('Advance Search filters', [9, 10]),
    requirement('Select All on the Release screen', [11, 12]),
  ],
  supporting_blocks: [background([1, 8, 13, 14], 'headings and background prose')],
};

/**
 * The observed regression: the mapping rows and the Select All context are
 * called background, so their behaviour left the pipeline entirely.
 */
const RUN_3 = {
  requirements: [
    requirement('Settlement release retry', [5, 6, 7]),
    requirement('Advance Search filters', [9, 10]),
  ],
  supporting_blocks: [
    background([3, 4], 'sample response values'),
    background([11, 12], 'screen description'),
    background([1, 2, 8, 13, 14], 'headings and background prose'),
  ],
};

async function structure(response) {
  return structureRequirements(DOCUMENTS, [{ documentId: 'DOC-001', blocks: BLOCKS }], {
    provider: new MockProvider({ responses: response }),
  });
}

/** What the run would measure coverage against, as a comparable set. */
async function universeOf(response) {
  const { requirements } = await structure(response);
  return new Set(
    deriveCoverageObligations(requirements).map(
      (entry) => `${entry.type}::${entry.statement.toLowerCase().replace(/\s+/g, ' ')}`
    )
  );
}

const has = (universe, pattern) => [...universe].some((entry) => pattern.test(entry));

describe('semantic coverage is stable across identical runs', () => {
  it('derives the same obligation universe from all three groupings', async () => {
    const one = await universeOf(RUN_1);
    const two = await universeOf(RUN_2);
    const three = await universeOf(RUN_3);

    assert.deepEqual(
      [...one].filter((entry) => !two.has(entry)),
      [],
      'merging two requirements lost a behaviour'
    );
    assert.deepEqual(
      [...one].filter((entry) => !three.has(entry)),
      [],
      'calling blocks background lost a behaviour'
    );
    assert.deepEqual(
      [...three].filter((entry) => !one.has(entry)),
      [],
      'recovery invented a behaviour the document does not state'
    );
  });

  it('keeps the response mapping rows when structuring calls them examples', async () => {
    const universe = await universeOf(RUN_3);

    assert.ok(has(universe, /mapping::.*00/), 'the success row survived');
    assert.ok(has(universe, /mapping::.*01/), 'the failure row survived');
  });

  it('keeps the Select All context when structuring calls it a screen description', async () => {
    const universe = await universeOf(RUN_3);

    assert.ok(has(universe, /hold/), 'the Release action and Settlement Type context survived');
    assert.ok(has(universe, /\b10\b/), 'the page size survived');
  });

  it('recovers the set-aside blocks as requirements rather than dropping them', async () => {
    const { requirements, warnings } = await structure(RUN_3);

    const recovered = requirements.filter((entry) =>
      entry.ambiguities.some((note) => note.startsWith('Recovered deterministically'))
    );

    assert.ok(recovered.length > 0, 'behavioural blocks came back');
    assert.equal(
      warnings.filter((warning) => warning.code === RECOVERY_WARNING).length,
      1,
      'and the reviewer is told, once'
    );
  });

  it('quotes the source verbatim in a recovered requirement', async () => {
    const { requirements } = await structure(RUN_3);

    const recovered = requirements.find((entry) =>
      entry.ambiguities.some((note) => note.startsWith('Recovered deterministically'))
    );

    const source = BLOCKS.map((block) => block.text).join('\n');
    for (const line of recovered.description.split('\n')) {
      assert.ok(source.includes(line), `recovered text is the source's own: ${line}`);
    }
    assert.ok(recovered.source_references.length > 0, 'and it carries its pages');
  });
});

/**
 * The other half. Recovery must not turn every discarded paragraph into a
 * requirement - a tool that recovers prose has only moved the noise problem,
 * and the reviewer stops reading the warning.
 */
describe('recovery is limited to blocks that state behaviour', () => {
  it('leaves background prose alone', async () => {
    const { requirements } = await structure(RUN_1);

    const bodies = requirements.map((entry) => entry.description).join('\n');
    assert.ok(!bodies.includes('serves as the core platform'), 'background prose stayed out');
    assert.ok(!bodies.includes('reviewed by the Reconciliation'), 'sign-off prose stayed out');
  });

  it('recovers nothing when the grouping already took every behaviour', async () => {
    const { requirements, warnings } = await structure(RUN_1);

    assert.equal(requirements.length, 4, 'the four grouped requirements, and nothing appended');
    assert.equal(warnings.filter((warning) => warning.code === RECOVERY_WARNING).length, 0);
  });

  /**
   * The ceiling on recovery is itself a place a behaviour could vanish, which
   * is the bug one level up. It stays - a document that recovers dozens of
   * requirements was never structured and burying the list helps nobody - but
   * what did not fit is counted and said out loud.
   */
  it('says how much behaviour did not fit when the ceiling is reached', async () => {
    // Interleaved, so each behavioural block is its own unclaimed run rather
    // than one long one - contiguous neighbours would otherwise merge into a
    // single recovered requirement and never reach the ceiling.
    const many = Array.from({ length: 14 }, (_, index) => [
      {
        kind: 'paragraph',
        text: `IF the response code is ${100 + index}, then set the transaction status to STATE${index}.`,
        page: 2,
      },
      { kind: 'paragraph', text: `Grouped paragraph ${index} describing the screen.`, page: 2 },
    ]).flat();

    const claimedPositions = Array.from({ length: 14 }, (_, index) => (index + 1) * 2);

    const result = await structureRequirements(
      DOCUMENTS,
      [{ documentId: 'DOC-001', blocks: many }],
      {
        provider: new MockProvider({
          responses: {
            requirements: [requirement('The grouped prose', claimedPositions)],
            supporting_blocks: [],
          },
        }),
      }
    );

    const [warning] = result.warnings.filter((entry) => entry.code === RECOVERY_WARNING);

    assert.ok(warning, 'recovery ran');
    assert.match(warning.message, /did NOT fit/, 'and the overflow is reported, not dropped');
  });

  it('does not renumber the requirements the grouping produced', async () => {
    const { requirements } = await structure(RUN_3);

    assert.equal(requirements[0].requirement_id, 'REQ-001');
    assert.equal(requirements[1].requirement_id, 'REQ-002');
    assert.ok(
      requirements.slice(2).every((entry) => /^REQ-\d{3}$/.test(entry.requirement_id)),
      'recovered requirements are appended with ids that continue the run'
    );
  });
});

/**
 * Recovery must not promote a passage that merely mentions a behaviour.
 *
 * Measured on the real PRD: the approval table, the background prose and the
 * objective bullets formed one unclaimed run of 2,704 characters whose only
 * obligation came from an objective saying the feature exists - "Implement an
 * isolated queue and automated check-status retry loop". Recovering it produced
 * a 59-block "requirement" and a permanent coverage gap restating a behaviour
 * the real requirement already owned in detail, with a limit and a guard.
 *
 * Density separates the two cleanly on that document: every genuine requirement
 * scored between 2.3 and 10.7 obligations per thousand characters, and the
 * background section scored 0.37.
 */
describe('recovery requires behavioural density, not a single mention', () => {
  /**
   * The front matter at the length that makes it what it is - faithful to the
   * measured case rather than trimmed to make the point. It is that length
   * beside a single retry mention that gives the low density; a shorter fixture
   * scores 1.21 and would pass, testing the threshold against nothing.
   */
  const BACKGROUND = [
    'PRD QR Manager Settlement Report',
    'Document Approval',
    'Created by',
    'Reviewed by',
    'Approved by',
    'Product Requirement Document',
    'Epic Link',
    'Project No 106/NHC/ITD/IT/2.03/VIII/23',
    'Document Status',
    'Product Manager @Selina Selina',
    'Lead Product Manager @Dennis Trisaputra',
    'Tech lead @Aldis Furqoni',
    'Engineering Manager @Armanda Caesario Cornelis',
    'Product Name QR Manager Settlement Report',
    'Name Title Project Role Signature',
    'Aldis Furqoni Tech Lead Tech Lead',
    'Name Title Project Role Signature',
    'Dennis Trisaputra Lead Product Manager',
    'Christopher Ivan Principal Engineer',
    'Selina Intern Product Manager',
    'Background',
    'The QR Manager application serves as the core platform for managing and executing ' +
      'QRIS settlement activities. Currently the Settlement Report module faces operational ' +
      'bottlenecks due to heavy data loading, manual extraction workflows and rigid UI ' +
      'constraints. The existing system lacks dynamic pagination and features a limited ' +
      'Advanced Search function that only supports a single combined data view. These ' +
      'limitations prevent the Reconciliation and Operations teams from efficiently ' +
      'filtering specific transaction states, reviewing pending tasks and exporting ' +
      'critical financial data on demand.',
    'Additionally, infrastructure timeouts during settlement releases to the Core Banking ' +
      'system via Middleware pose significant operational risks, as the application ' +
      'currently lacks an isolated automated recovery mechanism. To resolve these ' +
      'challenges, QR Manager requires an upgrade to optimize report rendering, expand ' +
      'search filtering capabilities, automate daily data pipelines for downstream ' +
      'reconciliation systems, and deploy a resilient asynchronous timeout engine to ' +
      'secure end-to-end settlement operations.',
    'Objective',
    'Improve report rendering through database tuning, updated page limits, and a new ' +
      'release timestamp column',
    'Expand filtering options within the advanced search criteria and ensure the export ' +
      'button is always functional',
    'Automate the daily generation and transfer of settlement report files for ' +
      'reconciliation purposes',
    'Implement an isolated queue and automated check-status retry loop to handle timed-out ' +
      'transactions without blocking the main workflow',
  ].join('\n');

  const DENSE = [
    'IF the status check returns FAILED, then trigger retry Release Settlement. ' +
      'The maximum number of retries is 3.',
    'IF the status remains unresolved after the 3rd retry, then mark the transaction FAILED.',
  ].join('\n');

  /**
   * A spacer block takes the grouping's citation, so every content line below it
   * is unclaimed and reaches recovery - which is the state under test.
   */
  async function recoverFrom(text) {
    const blocks = [
      { kind: 'paragraph', text: 'An unrelated grouped requirement line.', page: 1 },
      ...text.split('\n').map((line) => ({ kind: 'paragraph', text: line, page: 1 })),
    ];

    const result = await structureRequirements(DOCUMENTS, [{ documentId: 'DOC-001', blocks }], {
      provider: new MockProvider({
        responses: { requirements: [requirement('Grouped', [1])], supporting_blocks: [] },
      }),
    });

    return result.requirements.filter((entry) =>
      entry.ambiguities.some((note) => note.startsWith('Recovered'))
    );
  }

  it('does not recover a background section that mentions a behaviour once', async () => {
    assert.deepEqual(
      await recoverFrom(BACKGROUND),
      [],
      'prose with one incidental obligation is not a requirement'
    );
  });

  it('still recovers a passage that states behaviour throughout', async () => {
    const recovered = await recoverFrom(DENSE);

    assert.ok(recovered.length > 0, 'a dense behavioural run is still restored');
    assert.match(recovered[0].description, /retry Release Settlement/);
  });
});
