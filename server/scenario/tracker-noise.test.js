import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deriveCoverageObligations } from './obligations.js';

/**
 * Document furniture that was being read as behaviour.
 *
 * On the sanitised PRD, 8 of 42 obligations were not things the system does:
 * issue-tracker links from the "Jira Link" column (as acceptance criteria and as
 * a response code), the column header itself (as a UI action), a sample row (as
 * a response code), a page footer and a section number (as limits). Each was a
 * permanent line under "Partially covered", and a line in the generation prompt
 * asking the model to test it. The golden oracle files the tracker keys as
 * DOCUMENT_METADATA (GO-065) and the sample row as EXAMPLE_SAMPLE.
 *
 * The negative cases matter as much: a response code has the same shape as a
 * ticket key, and losing a real one is a coverage figure that is silently short.
 *
 * Texts are excerpts of the real sanitised PRD unless stated otherwise.
 */

const requirement = (id, description) => ({
  requirement_id: id,
  title: '',
  description,
  category: 'Functional Behavior',
  source_references: [],
  ambiguities: [],
  conflicts: [],
});

const statements = (obligations) => obligations.map((obligation) => obligation.statement);

// REQ-001 keeps the table's header row; REQ-002 is the same table's second row
// and does not - which is why the tracker check is made for the document.
const REQ_001 = requirement(
  'REQ-001',
  [
    '1. Set Default View, Implement Pagination and Add New Column on Transaction Data',
    'Scenario Acceptance Criteria Jira Link',
    'Default Table in Settlement Report',
    'GIVEN User is on the QR Manager Dashboard',
    'WHEN User opens the Settlement Report menu',
    'THEN the system must fulfill:',
    '- Automatically load and show transactions with the status Unsettled or Unreleased',
    '- Ensure to load all available data from all dates',
    'QRM-17394: Settlement',
    'Report - Default View',
  ].join('\n')
);

const REQ_002 = requirement(
  'REQ-002',
  [
    'Row Display and Pagination Limit GIVEN User is viewing the default Settlement Report table',
    'WHEN the data is fully rendered on screen',
    'THEN the system must fulfill:',
    '- Display a maximum of 10 rows of transaction per page',
    '- Display the navigation control buttons as Prev 10 and Next 10',
    'QRM-17394: Pagination update',
  ].join('\n')
);

const REQ_008 = requirement(
  'REQ-008',
  [
    'Scenario Acceptance Criteria Jira Link',
    'Status Verification and Conditional Retry GIVEN the interval time has passed and the isolated scheduler picks up the PENDING transaction',
    'WHEN the system executes the status verification',
    'THEN the system must fulfill:',
    '- Call Check Status to Core Banking via Middleware to verify the actual state of the transaction.',
    '- IF FAILED (Y.ISO.RESPONSE:1:1="01") or NOT FOUND, then trigger retry',
    'Release Settlement to Middleware. The maximum number of settlement release retries is 3.',
    'QRM-17521: Check Status',
    'Retry',
  ].join('\n')
);

const REQ_011 = requirement(
  'REQ-011',
  [
    '7. Tick All QR Transaction Release Settlement',
    'Scenario Acceptance Criteria Jira Link Tick All QR Transaction Release',
    'Settlement',
    'GIVEN the QR Manager user is on the Settlement Report page',
    'WHEN the user clicks the Release action button (Settlement Type: HOLD)',
    'THEN the system must fulfill the following:',
    '- Display a Select All checkbox on the page near the transaction list table',
    'Notes: Select All only applies to transactions on the current active page (up to 10 rows per page) and will not select items on other pages.',
    'QRM-19411: Select All',
    'Release Settlement',
  ].join('\n')
);

const REQ_013 = requirement(
  'REQ-013',
  [
    'Synthetic UI example',
    'QR Channel FT Number Status Release Transaction QRDEMO001 FTDEMO014922 PENDING n',
    'Example behavior: checking Select All selects only rows visible on the active page (maximum 10 rows), while rows on other pages remain unchanged.',
    'Page 12',
  ].join('\n')
);

const PRD = [REQ_001, REQ_002, REQ_008, REQ_011, REQ_013];

describe('issue-tracker links are not behaviour', () => {
  it('a Jira link under a THEN block is not an acceptance criterion', () => {
    const derived = statements(deriveCoverageObligations(PRD));

    assert.ok(
      derived.every((statement) => !/QRM-1\d{4}/.test(statement)),
      `no obligation names a ticket key: ${derived.filter((s) => /QRM-/.test(s)).join(' | ')}`
    );
  });

  it('applies to a table row that lost its own header, because the document named the tracker', () => {
    const derived = deriveCoverageObligations(PRD).filter((o) => o.requirement_id === 'REQ-002');

    assert.ok(statements(derived).every((statement) => !/QRM-17394/.test(statement)));
    assert.ok(
      statements(derived).some((statement) => /Prev 10 and Next 10/.test(statement)),
      'the real criteria beside it are still derived'
    );
  });

  it('is not read as a response code, even when its title says "Status"', () => {
    const derived = deriveCoverageObligations(PRD).filter((o) => o.requirement_id === 'REQ-008');
    const codes = derived.filter((o) => o.type === 'mapping').map((o) => o.metadata.code ?? null);

    assert.ok(!codes.includes('QRM-17521'));
    assert.ok(
      statements(derived).some((statement) => /Y\.ISO\.RESPONSE:1:1=01/.test(statement)),
      'the real response mapping in the same requirement is still derived'
    );
  });

  it('does not read the scenario table header as a UI action', () => {
    const derived = deriveCoverageObligations(PRD).filter((o) => o.requirement_id === 'REQ-011');

    assert.ok(statements(derived).every((statement) => !/Jira Link/.test(statement)));
    assert.ok(statements(derived).some((statement) => /Select All checkbox/.test(statement)));
  });
});

describe('the wrapped tail of a ticket title', () => {
  const filterBlock = (afterLink) =>
    requirement(
      'REQ-010',
      [
        'Scenario Acceptance Criteria Jira Link',
        'Add New Filter Options GIVEN QR Manager User open Settlement Report menu',
        'WHEN User click Advance Search filter dropdown',
        'THEN the system must fulfill the following:',
        '- Add a new dropdown field named Settlement Status placed directly below the existing Settlement Type dropdown.',
        'QRM-19347: Add New',
        afterLink,
      ].join('\n')
    );

  it('is not an acceptance criterion', () => {
    const derived = deriveCoverageObligations([filterBlock('Advance Search Filter')]);

    assert.ok(statements(derived).every((statement) => !/Advance Search Filter$/.test(statement)));
    assert.ok(
      statements(derived).some((statement) => /Add a new dropdown field/.test(statement)),
      'the criterion above the link is still derived'
    );
  });

  it('is told apart from a full sentence that happens to follow the link', () => {
    const derived = deriveCoverageObligations([
      filterBlock('Display all of the settled transactions in the table.'),
    ]);

    assert.ok(
      statements(derived).some((statement) => /Display all of the settled/.test(statement))
    );
  });
});

describe('a response code that looks like a ticket key is still a code', () => {
  // Synthetic: an error-code line in the same "KEY-NUMBER:" shape.
  const codeLine = 'QRIS-1001: Invalid QR - the payment is rejected with error code QRIS-1001.';

  it('in a document that never names an issue tracker', () => {
    const derived = deriveCoverageObligations([requirement('REQ-001', codeLine)]);

    assert.ok(derived.some((o) => o.type === 'mapping' && o.metadata.code === 'QRIS-1001'));
  });

  it('when it is zero-padded, even in a document that does name its tracker', () => {
    const derived = deriveCoverageObligations([
      REQ_001,
      requirement(
        'REQ-002',
        'ERR-001: Invalid amount - the transfer is rejected with error code ERR-001.'
      ),
    ]);

    assert.ok(derived.some((o) => o.type === 'mapping' && o.metadata.code === 'ERR-001'));
  });
});

describe('positions in the document are not limits', () => {
  const bounds = (requirementId) =>
    deriveCoverageObligations(PRD)
      .filter((o) => o.requirement_id === requirementId && o.type === 'bound')
      .map((o) => o.metadata.value);

  it('a page footer is not a boundary', () => {
    assert.deepEqual(bounds('REQ-013'), ['10']);
  });

  it("a section's own number is not a boundary", () => {
    assert.deepEqual(bounds('REQ-011'), ['10']);
  });

  it('a numbered rule still states its limit', () => {
    const derived = deriveCoverageObligations([
      requirement('REQ-001', '1. The transfer amount must not exceed 50,000,000 per day.'),
    ]);
    const values = derived.filter((o) => o.type === 'bound').map((o) => o.metadata.value);

    assert.deepEqual(values, ['50000000']);
  });
});

describe('"status" alone does not make a value a returned code', () => {
  it('a value under a Status column is not a response code', () => {
    const derived = deriveCoverageObligations(PRD).filter((o) => o.requirement_id === 'REQ-013');

    assert.ok(derived.every((o) => o.type !== 'mapping'));
  });

  it('a status code introduced another way is still read', () => {
    const derived = deriveCoverageObligations([
      requirement('REQ-001', 'The transfer returns status U253 when the account is dormant.'),
    ]);

    assert.ok(derived.some((o) => o.type === 'mapping' && o.metadata.code === 'U253'));
  });
});
