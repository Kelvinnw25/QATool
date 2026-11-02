import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deriveCoverageObligations } from './obligations.js';
import { structureRequirements } from '../structure/index.js';
import { MockProvider } from '../llm/mock.js';

/**
 * Conditional sentences the PDF wrapped, read back whole.
 *
 * GO-019 traced end to end: the PDF text layer holds the sentence, the parser
 * yields it as two consecutive line blocks, structuring rebuilds it verbatim
 * into REQ-008 - and obligation derivation cut it at the line break into
 * "IF ... still Timeout, perform" and "Check Status again.", neither of which
 * the branch detector could read (it also read only the THEN form). No
 * obligation, so the generation plan never had to account for the re-check,
 * and it was dropped in four runs of ten.
 *
 * Texts below are the real PRD's lines, exactly as the parser emits them.
 */

const requirement = (description, id = 'REQ-001') => ({
  requirement_id: id,
  title: 'Status Verification and Conditional Retry',
  description,
  category: 'Error Handling',
  source_references: [],
  ambiguities: [],
  conflicts: [],
});

const branches = (description) =>
  deriveCoverageObligations([requirement(description)]).filter((o) => o.type === 'branch');

/** REQ-008's IF lines from the original PRD, page 8, one parser block per line. */
const PAGE_8 = [
  'Call Check Status to T24 via MW (mscore*) to verify the actual state of the transaction',
  'IF FAILED (Y.ISO.RESPONSE:1:1="01") or NOT',
  'FOUND, then trigger retry Release Settlement to MW. The maximum number of settlement release retries is 3.',
  'IF after Release Settlement 1 and/or 2 retries attempt the transaction still Timeout, perform',
  'Check Status again.',
  'IF the status remains unresolved (FAILED) after 3rd retry attempt, permanently mark the transaction status as FAILED',
  'Notes: Retry for Settlement Release is only performed when the status check response is',
  'FAILED (transaction not completed) and the retry attempt has not reached 3 times.',
];

describe('the GO-019 passage', () => {
  const description = PAGE_8.join('\n');
  const recheck = () =>
    branches(description).find((o) => /perform Check Status again/.test(o.metadata.outcome));

  it('becomes one branch obligation with its whole condition and its whole consequent', () => {
    const branch = recheck();

    assert.ok(branch, 'the re-check after a timed-out retry is derived');
    assert.equal(
      branch.metadata.condition,
      'after Release Settlement 1 and/or 2 retries attempt the transaction still Timeout'
    );
    assert.equal(branch.metadata.outcome, 'perform Check Status again');
    assert.match(branch.statement, /still Timeout: perform Check Status again/, 'nothing cut away');
  });

  it('keeps the basis verbatim: one slice of the requirement, line break and all', () => {
    const branch = recheck();

    assert.ok(description.includes(branch.source_basis));
    assert.equal(
      branch.source_basis,
      'IF after Release Settlement 1 and/or 2 retries attempt the transaction still Timeout, perform\nCheck Status again.'
    );
  });

  it('also rebuilds the THEN-form rule the same page wrapped', () => {
    const failed = branches(description).find((o) => /^FAILED/.test(o.metadata.condition));

    assert.ok(failed);
    assert.equal(failed.metadata.condition, 'FAILED (Y.ISO.RESPONSE:1:1="01") or NOT FOUND');
    assert.equal(failed.metadata.outcome, 'trigger retry Release Settlement to MW');
  });

  it('does not borrow the note below it', () => {
    for (const branch of branches(description)) {
      assert.doesNotMatch(branch.source_basis, /Notes:/);
    }
  });
});

describe('provenance through structuring', () => {
  const DOCUMENTS = [
    {
      document_id: 'DOC-001',
      filename: 'PRD.pdf',
      document_type: 'PRD',
      status: 'Extracted',
      page_count: 12,
    },
  ];

  const blocks = (lines) => lines.map((text) => ({ kind: 'paragraph', text, page: 8 }));

  /** A model that groups every block it was shown into one requirement. */
  const greedy = ({ prompt }) => ({
    requirements: [
      {
        title: 'Status Verification and Conditional Retry',
        source_block_ids: [...new Set(String(prompt).match(/DOC-001-B\d{3}/g) ?? [])],
        test_points: [],
        ambiguous: false,
        conflicted: false,
        fragmented: false,
      },
    ],
    supporting_blocks: [],
  });

  async function structure(parsed) {
    const result = await structureRequirements(
      DOCUMENTS,
      [{ documentId: 'DOC-001', blocks: parsed }],
      {
        provider: new MockProvider({ responses: greedy }),
      }
    );
    return result.requirements;
  }

  it('keeps both line blocks as their own source references, and the text verbatim', async () => {
    const [built] = await structure(blocks(PAGE_8.slice(3, 5)));

    assert.equal(built.source_references.length, 2, 'one reference per printed line');
    assert.deepEqual(
      built.source_references.map((reference) => reference.quote),
      [PAGE_8[3], PAGE_8[4]]
    );
    assert.match(built.description, /still Timeout, perform\nCheck Status again\./);
  });

  it('reconstructs the rule from what structuring produced', async () => {
    const [built] = await structure(blocks(PAGE_8.slice(3, 5)));
    const derived = deriveCoverageObligations([built]).filter((o) => o.type === 'branch');

    assert.equal(derived.length, 1);
    assert.equal(derived[0].metadata.outcome, 'perform Check Status again');
  });

  /**
   * A page break with a picture on it is where a wrap and an image meet. The
   * picture's placeholder is never numbered (the image boundary), so it cannot
   * land between the halves - and its absence must not stop the rejoin.
   */
  it('ignores an unread image between the two halves', async () => {
    const [built] = await structure([
      ...blocks([PAGE_8[3]]),
      {
        kind: 'image_region',
        text: '[Image on page 8, 200x80pt. Its content is not in the PDF text layer and was not read.]',
        page: 8,
      },
      ...blocks([PAGE_8[4]]),
    ]);

    assert.doesNotMatch(built.description, /Image on page/);
    const derived = deriveCoverageObligations([built]).filter((o) => o.type === 'branch');
    assert.equal(derived[0]?.metadata.outcome, 'perform Check Status again');
    assert.doesNotMatch(derived[0].source_basis, /Image on page/);
  });
});

describe('line wraps that are not this defect stay as they were', () => {
  it('does not join a complete rule to the unrelated line after it', () => {
    const [branch] = branches(
      'IF the User pick Settled filter, display all of the settled transaction\nDisplay the Export button as active'
    );

    assert.equal(branch.metadata.outcome, 'display all of the settled transaction');
    assert.doesNotMatch(branch.source_basis, /Export/);
  });

  it('does not join across a new IF', () => {
    const derived = branches(
      'IF FAILED (Y.ISO.RESPONSE:1:1="01") or NOT\nIF the status remains unresolved, display the error'
    );

    assert.ok(derived.every((o) => !/NOT IF/.test(o.source_basis)));
  });

  it('does not invent a consequent the lines never supply', () => {
    assert.deepEqual(
      branches('IF FAILED (Y.ISO.RESPONSE:1:1="01") or NOT\nFOUND\nwhile pending\nin queue'),
      [],
      'three continuation lines and still no consequent: no branch'
    );
  });

  it('leaves a wrapped line that is not a conditional alone', () => {
    assert.deepEqual(
      branches(
        'Generate the final report file in .txt format using a\ntilde ~ as the data delimiter'
      ),
      []
    );
  });

  it('leaves a single-line THEN rule exactly as the THEN rule reads it', () => {
    const [branch] = branches(
      'IF the User pick Unsettled filter, then display all of the unsettled transaction'
    );

    assert.equal(
      branch.statement,
      'Branch - when the User pick Unsettled filter: display all of the unsettled transaction'
    );
  });
});

describe('the comma form is read conservatively', () => {
  it('splits at the comma that opens an action, not at one inside a list', () => {
    const [branch] = branches(
      'IF the response is FAILED, NOT FOUND or TIMEOUT, reject the release request.'
    );

    assert.equal(branch.metadata.condition, 'the response is FAILED, NOT FOUND or TIMEOUT');
    assert.equal(branch.metadata.outcome, 'reject the release request');
  });

  it('reads nothing when no comma is followed by an action', () => {
    assert.deepEqual(branches('If the account is dormant, the transfer is rejected.'), []);
  });

  it('reads nothing when the action is not one it recognises', () => {
    assert.deepEqual(
      branches(
        'IF the status remains unresolved (FAILED) after 3rd retry attempt, permanently mark the transaction status as FAILED'
      ),
      [],
      'unchanged from before: "mark" is not in the action list'
    );
  });
});
