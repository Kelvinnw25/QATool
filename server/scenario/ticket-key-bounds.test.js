import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { boundsFor, deriveChecklist, statedValues } from './checklist.js';
import { deriveCoverageObligations } from './obligations.js';

/**
 * A ticket key is a name, not a limit - even when a real limit is next to it.
 *
 * On the real PRD, Gemini #1 once grouped the pagination scenario with the
 * section above it, so one requirement held both "Jira NPWOW Link NPWOW31-650"
 * and "Display a maximum of 10 rows". The limit wording opened the bound gate,
 * and 650 became "Boundary 650 is exercised": the generator wrote a test case
 * "exercising boundary 650" and the matcher counted it covered. The key had
 * lost only "NPWOW31" to the code-shape rule (ADMI 002), and the "-650" left
 * over no longer looked like a key.
 *
 * The older ticket-key test passed without exercising this: with no limit
 * wording in the text, no bound is read at all. Every text here carries a
 * real limit, so the key is what is being tested.
 */

function requirement(description) {
  return {
    requirement_id: 'REQ-001',
    title: 'Requirement',
    description,
    category: 'Functional Behavior',
    source_references: [],
    ambiguities: [],
    conflicts: [],
  };
}

const derive = (...lines) => deriveCoverageObligations([requirement(lines.join('\n'))]);
const typed = (obligations, type) => obligations.filter((entry) => entry.type === type);
const boundValues = (obligations) =>
  typed(obligations, 'bound').map((entry) => entry.metadata.value);

const PAGINATION = 'Display a maximum of 10 rows of transaction per page';

// The real PRD's merged requirement, as Gemini #1 grouped it (lines 0-18).
const MERGED = [
  '1. Set Default View, Implement Pagination and Add New Column on Transaction Data',
  'Jira NPWOW Link NPWOW31-650: Penambahan Switching Artajasa',
  '/ ATMB untuk layanan QRIS Bank Sinarmas',
  'Ready for Deployment',
  'GIVEN User is on the QR Manager Dashboard',
  'WHEN User opens the Settlement Report menu',
  'THEN the system must fulfill:',
  'Automatically load and show transactions with the status Unsettled or Unreleased',
  'Ensure to load all available data from all dates',
  'Row Display and',
  'Pagination Limit',
  'GIVEN User is viewing the default Settlement Report table',
  'WHEN the data is fully rendered on screen',
  'THEN the system must fulfill:',
  PAGINATION,
  'Display the navigation control buttons as Prev 10 and Next 10 (current condition: Prev 100 and Next 100)',
  'Scenario Acceptance Criteria Jira Link SDE4-17394:',
];

describe('a ticket key next to a real limit', () => {
  it('reads no bound out of NPWOW31-650 - the real PRD case', () => {
    assert.deepEqual(boundValues(derive(...MERGED)), ['10']);
  });

  for (const key of [
    'NPWOW31-650',
    'SDE4-17394',
    'SDE4-17521',
    'QRM-17394',
    'ABCD12-345',
    'PROJ2026-77',
  ]) {
    it(`reads no bound out of ${key}`, () => {
      const text = `Tracked in ${key}.\n${PAGINATION}`;
      const number = key.split('-')[1];

      assert.deepEqual(
        boundsFor(text).map((bound) => bound.normalized),
        ['10']
      );
      assert.ok(!statedValues(text).has(number), `${number} is part of ${key}`);
      assert.deepEqual(boundValues(derive(`Tracked in ${key}.`, PAGINATION)), ['10']);
    });
  }

  it('keeps the key out of the checklist the generator is shown', () => {
    const [entry] = deriveChecklist([requirement(MERGED.join('\n'))]);
    const values = entry.bounds.map((bound) => bound.normalized);

    assert.ok(!values.includes('650'), values.join(','));
    assert.ok(!values.includes('17394'), values.join(','));
    assert.ok(values.includes('10'), values.join(','));
  });

  // The checklist reads `${title} ${description}`, so a section number that opens
  // the description - "1. Set Default View ..." - is no longer at the start of a
  // line and is read as the value 1. On the real PRD this put "1" into REQ-001's
  // checklist bounds. A separate defect from ticket keys; not fixed here.
  it.todo('reads no bound out of a section number the title is joined to', () => {
    const [entry] = deriveChecklist([requirement(MERGED.join('\n'))]);

    assert.deepEqual(
      entry.bounds.map((bound) => bound.normalized),
      ['10']
    );
  });
});

describe('real limits stay', () => {
  it('keeps the pagination limit 10 as a maximum', () => {
    const [bound] = typed(derive(...MERGED), 'bound');

    assert.equal(bound.metadata.value, '10');
    assert.equal(bound.metadata.kind, 'maximum');
    assert.equal(bound.source_basis, PAGINATION);
  });

  it('keeps the retry limit 3 beside a ticket key', () => {
    const retry = typed(
      derive(
        'Reference SDE4-17521: Redefine Time out Transaction Logic.',
        'GIVEN the scheduler picks up the PENDING transaction',
        'WHEN the system executes the status verification',
        'THEN the system must fulfill:',
        'IF FAILED (Y.ISO.RESPONSE:1:1="01") or NOT FOUND, then trigger retry Release Settlement to MW. The maximum number of settlement release retries is 3.'
      ),
      'retry'
    );

    assert.ok(
      retry.some((entry) => entry.metadata.limit === '3'),
      JSON.stringify(retry)
    );
  });

  it('keeps the one-hour delay beside a ticket key', () => {
    const schedule = typed(
      derive(
        'Scenario Acceptance Criteria Jira Link SDE4-17521:',
        'WHEN QR Manager proceed Release Settlement to T24 via MW and experience Timeout',
        'THEN the system must fulfill:',
        'Enforce a strict 1 hour delay from the original timeout timestamp before allowing the scheduler to process the record (giving the Core Banking system a cool-down period).'
      ),
      'schedule'
    );

    assert.deepEqual(
      schedule.map((entry) => [entry.metadata.amount, entry.metadata.unit]),
      [['1', 'hour']]
    );
  });

  it('keeps an amount, and still drops a response code and a page footer', () => {
    assert.deepEqual(
      boundsFor('The amount must not exceed IDR 50,000,000.').map((bound) => bound.normalized),
      ['50000000']
    );
    assert.deepEqual(
      boundsFor('Rejected with error ADMI 002 when the length exceeds 35 characters.').map(
        (bound) => bound.normalized
      ),
      ['35']
    );
    assert.deepEqual(
      boundsFor('Page 12 of 30\nup to 10 rows per page').map((bound) => bound.normalized),
      ['10']
    );
  });
});
