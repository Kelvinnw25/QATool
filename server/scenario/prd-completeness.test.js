import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deriveCoverageObligations, matchObligations } from './obligations.js';
import { classifyMeasurability } from './measurability.js';

/**
 * Eight behaviours a real PRD states that coverage kept failing to account for.
 *
 * Each was traced backward through the whole chain - source block, structuring,
 * recovery, obligation, test case, coverage - and every one turned out to fail
 * in the deterministic layer rather than in the model:
 *
 *   the two core banking response rows  no obligation at all. A test case
 *                                       happened to cover them, which is worse
 *                                       than a gap: nothing guaranteed the next
 *                                       run would.
 *   mscore, Transaction Date, HOLD      stated in brackets, and brackets were
 *                                       not read, so losing them cost nothing
 *   the retry guard                      derived, but cut at a line wrap, so it
 *                                       named a restriction and omitted it
 *   eight "the system must fulfill:"     branches demanding a lead-in, none of
 *                                       them satisfiable by anything
 *   a Jira key                           reported as "a limit of 17394"
 *   T24                                  a system name reported three times as
 *                                       a response code
 *
 * The measured effect on one PRD: 16 of 30 obligations covered, where nine of
 * the fourteen "gaps" were not behaviours. After these fixes, 20 of 24, and
 * every remaining gap is a real one a reviewer can act on.
 *
 * The wording below is the document's own, because that is the point - these
 * shapes are what defeated the detectors, and a tidied paraphrase would not
 * reproduce any of them.
 */

function requirement(description, id = 'REQ-001') {
  return {
    requirement_id: id,
    title: 'Status verification',
    description,
    category: 'Business Rule',
    source_references: [{ document_id: 'DOC-001', page: 8, section: null, quote: null }],
    ambiguities: [],
    conflicts: [],
  };
}

const derive = (description) => deriveCoverageObligations([requirement(description)]);
const typed = (description, type) => derive(description).filter((entry) => entry.type === type);

function testCase(action, expected, overrides = {}) {
  return {
    case_id: 'TC-001',
    requirement_ids: ['REQ-001'],
    test_case: action,
    expected_result: expected,
    case_type: 'Positive',
    edge_polarity: null,
    ...overrides,
  };
}

const coversAll = (description, cases) => {
  const matched = matchObligations(derive(description), cases);
  return matched.filter((entry) => !entry.covered);
};

// --- 1 and 2: the core banking response rows ---------------------------------

describe('a response value and the meaning the source gives it', () => {
  const SUCCESS =
    'IF check status response from T24 is Success (Y.ISO.RESPONSE:1:1="00" and\n' +
    'Y.MSG.RES:1:1="{{ada isi FT Number nya}}" ), update the DB status to SUCCESS and save the FT NUMBER';

  const FAILURE =
    'IF FAILED (Y.ISO.RESPONSE:1:1="01") or NOT\nFOUND, then trigger retry Release Settlement to MW.';

  /**
   * The meaning precedes the value here, and the closing bracket is on the next
   * line. Both defeated the mapping detector, which wanted `value -> meaning`
   * inside one segment - so the success rule the whole feature turns on derived
   * nothing.
   */
  it('derives the success row although the meaning comes first and the bracket wraps', () => {
    const mappings = typed(SUCCESS, 'mapping');

    assert.ok(mappings.length > 0, 'the row is an obligation');
    const stated = mappings.map((entry) => entry.metadata.stated);
    assert.ok(
      stated.some((value) => value.includes('Y.ISO.RESPONSE:1:1=00')),
      `the stated value survives: ${stated.join(' | ')}`
    );
    assert.ok(
      mappings.some((entry) => /Success/i.test(entry.metadata.meaning)),
      'and so does the meaning the document gives it'
    );
  });

  it('derives the failure row', () => {
    const mappings = typed(FAILURE, 'mapping');

    assert.ok(
      mappings.some((entry) => entry.metadata.stated.includes('Y.ISO.RESPONSE:1:1=01')),
      'the failure value is an obligation'
    );
    assert.ok(
      mappings.some((entry) => /FAILED/i.test(entry.metadata.meaning)),
      'read as FAILED'
    );
  });

  /** The connective is not the meaning: "T24 is Success" is Success. */
  it('does not carry the introducing clause into the meaning', () => {
    for (const entry of typed(SUCCESS, 'mapping')) {
      assert.doesNotMatch(entry.metadata.meaning, /^(?:IF|T24 is)\b/i, entry.metadata.meaning);
    }
  });

  it('keeps the source basis verbatim', () => {
    for (const entry of typed(SUCCESS, 'mapping')) {
      assert.ok(SUCCESS.includes(entry.source_basis), entry.source_basis);
    }
  });

  /**
   * A placeholder says a field is populated, not what it equals, so it is not a
   * value the system can be tested against.
   */
  it('does not turn a placeholder into a stated value', () => {
    for (const entry of typed(SUCCESS, 'mapping')) {
      assert.doesNotMatch(entry.metadata.stated, /\{\{/, entry.metadata.stated);
    }
  });

  it('is covered by a case naming the value and its meaning', () => {
    const uncovered = coversAll(SUCCESS, [
      testCase(
        'Verify successful check status response handling and DB update with FT Number.',
        'If the response is Success (Y.ISO.RESPONSE:1:1="00"), the DB status is updated to SUCCESS and the FT NUMBER is saved.'
      ),
    ]);

    assert.deepEqual(
      uncovered.filter((entry) => entry.type === 'mapping'),
      []
    );
  });
});

// --- 3, 4, 5: qualifiers stated in brackets ----------------------------------

describe('a qualifier the source states in brackets', () => {
  const MSCORE = 'Call Check Status to T24 via MW (mscore*) to verify the actual state.';
  const FILE_NAME =
    'Use SETTLEMENT_QRMANAGER_DDMMYYYY.txt as file name format (Date using Transaction Date)';
  const HOLD = 'WHEN the user clicks the Release action button (Settlement Type: HOLD)';

  it('derives mscore as an obligation of its own', () => {
    const [qualifier] = typed(MSCORE, 'qualifier');

    assert.ok(qualifier, 'the component is an obligation');
    assert.equal(qualifier.metadata.qualifier, 'mscore*');
  });

  it('derives the Transaction Date the file name is built from', () => {
    const [qualifier] = typed(FILE_NAME, 'qualifier');

    assert.ok(qualifier);
    assert.match(qualifier.metadata.key, /Transaction Date/);
  });

  it('derives the Settlement Type the Select All context depends on', () => {
    const [qualifier] = typed(HOLD, 'qualifier');

    assert.ok(qualifier);
    assert.match(qualifier.metadata.qualifier, /HOLD/);
  });

  /** A case repeating the stated term covers it; the whole point of the type. */
  it('is covered when the case keeps the stated term', () => {
    assert.deepEqual(
      coversAll(FILE_NAME, [
        testCase(
          'Verify the report file name format.',
          'The file is named SETTLEMENT_QRMANAGER_DDMMYYYY.txt using Transaction Date.'
        ),
      ]).filter((entry) => entry.type === 'qualifier'),
      []
    );
  });

  /** And is reported when the case generalises it away. This is the mscore gap. */
  it('is uncovered when the case drops the stated term', () => {
    const uncovered = coversAll(MSCORE, [
      testCase(
        'Verify the status is checked against the core banking system.',
        'Check Status is called to T24 via MW and the state is returned.'
      ),
    ]).filter((entry) => entry.type === 'qualifier');

    assert.equal(uncovered.length, 1, 'dropping mscore is a reported gap, not a silent one');
    assert.match(uncovered[0].statement, /mscore/);
  });

  /**
   * The negatives, which matter more. A parenthesis is also how a document
   * glosses a term or renames a noun, and neither is a behaviour.
   */
  it('derives nothing from a gloss', () => {
    for (const text of [
      'IF the status remains unresolved (FAILED) after 3rd retry attempt.',
      'Transaction Not Found / Failed (FT is not recorded)',
      'The retry is skipped (transaction not completed).',
    ]) {
      assert.deepEqual(typed(text, 'qualifier'), [], text);
    }
  });

  /**
   * An apposition renames the noun before it rather than narrowing behaviour.
   * Read as a qualifier, "the Core Banking system (T24)" produced an obligation
   * demanding that a sentence of background prose be tested.
   */
  it('derives nothing from a bare name in brackets', () => {
    assert.deepEqual(
      typed(
        'Infrastructure timeouts during releases to the Core Banking system (T24).',
        'qualifier'
      ),
      []
    );
  });
});

// --- 6: the guard --------------------------------------------------------------

describe('a guard sentence the document line-wrapped', () => {
  const GUARD =
    'Notes: Retry for Settlement Release is only performed when the status check response is\n' +
    'FAILED (transaction not completed) and the retry attempt has not reached 3 times';

  it('keeps both halves of the condition', () => {
    const [guard] = typed(GUARD, 'condition').filter((entry) => /Guard/.test(entry.statement));

    assert.ok(guard, 'the guard is derived');
    assert.match(guard.statement, /FAILED/, 'the status half');
    assert.match(guard.statement, /has not reached 3/, 'and the attempt-count half');
  });

  it('keeps the basis verbatim across the wrap', () => {
    const [guard] = typed(GUARD, 'condition').filter((entry) => /Guard/.test(entry.statement));

    assert.ok(GUARD.includes(guard.source_basis), guard.source_basis);
  });

  /**
   * The extension is one wrapped line, not "forward until a full stop". This
   * guard has no full stop at all, and searching for one ran into the next
   * paragraph and pulled an unrelated sentence into the obligation.
   */
  it('does not swallow the sentence that follows', () => {
    const [guard] = typed(
      `${GUARD}\nBelow is the Request OFS Message via mscore :`,
      'condition'
    ).filter((entry) => /Guard/.test(entry.statement));

    assert.doesNotMatch(guard.source_basis, /OFS Message/);
  });

  it('is reported when no case proves the restriction', () => {
    const uncovered = coversAll(GUARD, [
      testCase('Verify a retry is triggered.', 'A retry of the release is triggered.'),
    ]).filter((entry) => /Guard/.test(entry.statement));

    assert.equal(uncovered.length, 1, 'the guard is named as a gap');
  });
});

// --- 7 and 8: nothing invented ------------------------------------------------

describe('what must never be manufactured', () => {
  /** "quickly" is not a threshold. No bound, and nothing measurable to chase. */
  it('reads no bound out of a vague quality', () => {
    const text = 'THEN the transaction data grid loads quickly after table tuning.';

    assert.deepEqual(typed(text, 'bound'), []);
    for (const entry of derive(text)) {
      if (/quickly/.test(entry.source_basis)) {
        assert.equal(
          classifyMeasurability(entry).measurable,
          false,
          'and if a behaviour is derived from it, it is excused rather than counted a miss'
        );
      }
    }
  });

  /** A Jira key is not a limit. This was reported as "a limit of 17394". */
  it('reads no bound out of a ticket key', () => {
    for (const text of [
      'Scenario Acceptance Criteria Jira Link SDE4-17394:',
      'Reference SDE4-17521: Redefine Time out Transaction Logic.',
      'See REQ-001 and KLR-01 for context.',
    ]) {
      assert.deepEqual(typed(text, 'bound'), [], text);
    }
  });

  /** A system you call is not a code it returns. Three of these on one PRD. */
  it('reads no response code out of a named system', () => {
    for (const text of [
      'Call Check Status to T24 via MW to verify the state.',
      'Below is the Response from T24 via mscore :',
      'The status check response from T24 is recorded.',
    ]) {
      assert.deepEqual(
        typed(text, 'mapping').filter((entry) => entry.metadata.code),
        [],
        text
      );
    }
  });

  it('still reads a real response code', () => {
    const codes = typed('The instruction is rejected with error code ADMI 002.', 'mapping')
      .map((entry) => entry.metadata.code)
      .filter(Boolean);

    assert.deepEqual(codes, ['ADMI 002']);
  });
});

// --- the lead-in branches -----------------------------------------------------

describe('a colon lead-in is not an outcome', () => {
  it('derives no branch from an inline lead-in', () => {
    assert.deepEqual(
      typed(
        'WHEN the system executes the status verification THEN the system must fulfill:',
        'branch'
      ),
      []
    );
  });

  it('derives no branch from the block form', () => {
    const block =
      'GIVEN User is on the QR Manager Dashboard\n' +
      'WHEN User opens the Settlement Report menu\n' +
      'THEN the system must fulfill:\n' +
      'Automatically load transactions with status Unsettled or Unreleased';

    for (const entry of typed(block, 'branch')) {
      assert.doesNotMatch(entry.statement, /must fulfill:$/, entry.statement);
    }
  });

  /** A real consequent containing a colon is still a consequent. */
  it('still derives a branch whose outcome merely contains a colon', () => {
    const branches = typed(
      'IF the User pick Settled filter, then display the following: all settled transactions',
      'branch'
    );

    assert.equal(branches.length, 1);
    assert.match(branches[0].metadata.outcome, /all settled transactions/);
  });
});

// --- the matcher --------------------------------------------------------------

describe('a rephrased outcome still counts as covered', () => {
  /**
   * "display all of the settled transaction" against "displays all settled
   * transactions" shared one word in four and was reported as an untested
   * branch. A coverage report that calls a tested behaviour untested is the
   * most expensive kind of wrong, because the reviewer writes the case twice.
   */
  it('matches across an English plural', () => {
    const uncovered = coversAll(
      'IF the User pick Settled filter, then display all of the settled transaction',
      [
        testCase(
          'Verify data rendering when selecting Settled filter in Advanced Search.',
          'The system displays all settled transactions within the chosen period.'
        ),
      ]
    );

    assert.deepEqual(
      uncovered.filter((entry) => entry.type === 'branch'),
      []
    );
  });
});

// --- a trigger is not a behaviour ---------------------------------------------

describe('a GIVEN/WHEN trigger line', () => {
  const BLOCK =
    'GIVEN QR Manager User is on the Settlement Report menu with data rendered\n' +
    'WHEN moves the cursor over or clicks Export button\n' +
    'THEN the system must fulfill:\n' +
    'Maintain the Export to TXT button status as active and enabled under all data states\n' +
    'Trigger the file generation or download process immediately upon clicking';

  /**
   * "WHEN moves the cursor over or clicks Export button" cannot be passed or
   * failed. What can be checked is on the two lines below it, and both derive
   * their own obligations - so counting the trigger too created a gap that no
   * test case could ever close.
   */
  it('is not a UI obligation when the outcomes are stated on their own lines', () => {
    for (const entry of typed(BLOCK, 'ui_action')) {
      assert.doesNotMatch(entry.statement, /moves the cursor/, entry.statement);
      assert.doesNotMatch(entry.statement, /^UI behaviour: (?:WHEN|GIVEN)\b/i, entry.statement);
    }
  });

  /**
   * The bullets the trigger introduces ARE obligations, which is the whole
   * reason suppressing the trigger is safe.
   *
   * Suppressing it first exposed that nothing read them: a state requirement
   * ("Maintain the Export to TXT button status as active and enabled under all
   * data states") and an imperative ("Trigger the file generation or download
   * process immediately upon clicking") matched no detector, because UI_VERB is
   * an interaction vocabulary - click, select, press - and neither "Maintain"
   * nor "Trigger" is in it. This requirement derived nothing at all, and a
   * requirement with explicit testable criteria contributing nothing to the
   * denominator is exactly the silent loss the obligation layer exists to stop.
   */
  it('derives the criteria the trigger introduces', () => {
    const statements = derive(BLOCK).map((entry) => entry.statement);

    assert.ok(
      statements.some((statement) => /Maintain the Export to TXT button/.test(statement)),
      `the state requirement is an obligation: ${statements.join(' | ')}`
    );
    assert.ok(
      statements.some((statement) => /Trigger the file generation/.test(statement)),
      'and so is the imperative'
    );
  });

  /**
   * The safety valves. A trigger that carries its own consequent is a behaviour,
   * and a document that never writes a standalone THEN has no other line for the
   * outcome to live on - so in both cases the WHEN is all there is.
   */
  it('is kept when it carries its own consequent', () => {
    const inline = 'WHEN the user clicks the Export button then the system downloads the file';
    const derived = derive(inline);

    assert.ok(derived.length > 0, 'an inline outcome makes the WHEN line a behaviour');

    // Read as a branch rather than a UI action, which is the better of the two:
    // it separates the condition from the outcome, where "UI behaviour: <the
    // whole line>" only restates it. The coarse reading is dropped in favour of
    // the named one, so the behaviour is represented exactly once.
    assert.deepEqual(
      derived.map((entry) => entry.type),
      ['branch']
    );
    assert.match(derived[0].metadata.outcome, /downloads the file/);
  });

  it('is kept when the requirement states no separate THEN', () => {
    const noThen =
      'WHEN User click Advance Search filter dropdown\n' +
      'A new dropdown field named Settlement Status is displayed on the page.';

    assert.ok(typed(noThen, 'ui_action').length > 0);
  });

  it('leaves an imperative UI requirement alone', () => {
    const imperative =
      'WHEN the user opens the page\n' +
      'THEN the system must fulfill:\n' +
      'Display a Select All checkbox on the page near the transaction list table';

    assert.ok(
      typed(imperative, 'ui_action').some((entry) => /Select All checkbox/.test(entry.statement)),
      'a stated control is still an obligation'
    );
  });
});

// --- a heading is not a behaviour ---------------------------------------------

describe('a cue word standing alone', () => {
  /**
   * The parser split the section title "Status Verification and Conditional
   * Retry" across two lines, leaving "Retry" as a segment. It matched the retry
   * vocabulary and became an obligation whose entire evidence was that one word.
   */
  it('derives no retry obligation from a one-word heading', () => {
    for (const text of ['Retry', 'Retry\nStatus Verification and Conditional', 'Retry Logic']) {
      assert.deepEqual(typed(text, 'retry'), [], text);
    }
  });

  it('still derives the behaviour and the limit from a real retry rule', () => {
    const rule =
      'IF FAILED or NOT FOUND, then trigger retry Release Settlement to MW. ' +
      'The maximum number of settlement release retries is 3.';
    const retries = typed(rule, 'retry');

    assert.equal(retries.length, 2, 'the behaviour and the cap');
    assert.ok(retries.some((entry) => entry.metadata.limit === '3'));
  });

  it('still derives a short but complete retry sentence', () => {
    assert.ok(typed('The system retries the release up to 3 times.', 'retry').length > 0);
  });
});

// --- acceptance criteria under a THEN lead-in ---------------------------------

describe('the bullets under a THEN lead-in', () => {
  const block = (...lines) =>
    [
      'GIVEN the user is on the Settlement Report menu',
      'WHEN the user opens it',
      'THEN the system must fulfill:',
      ...lines,
    ].join('\n');

  const criteria = (description) =>
    typed(description, 'criterion').map((entry) => entry.metadata.criterion);

  /**
   * Four requirements on the real PRD derived NOTHING because of this. Their
   * criteria are imperative sentences and state requirements, and every existing
   * detector wanted something else: an interaction verb, an IF, a shouted
   * artifact name, a stated value.
   */
  it('reads a state-preservation requirement', () => {
    assert.deepEqual(
      criteria(
        block(
          'Maintain the Export to TXT button status as active and enabled under all data states'
        )
      ),
      ['Maintain the Export to TXT button status as active and enabled under all data states']
    );
  });

  it('reads an imperative behaviour', () => {
    assert.deepEqual(
      criteria(block('Trigger the file generation or download process immediately upon clicking')),
      ['Trigger the file generation or download process immediately upon clicking']
    );
  });

  it('reads every bullet in the list, not only the first', () => {
    assert.equal(
      criteria(
        block(
          'Automatically load and show transactions with the status Unsettled or Unreleased',
          'Ensure to load all available data from all dates'
        )
      ).length,
      2
    );
  });

  /** A wrapped fragment between two bullets must not end the list. */
  it('skips a wrapped fragment and keeps the bullet after it', () => {
    const found = criteria(
      block(
        'Add and display new data column for RELEASE',
        'DATE AND TIME to the table',
        'Include these timestamps inside the report file'
      )
    );

    assert.equal(found.length, 2, `the fragment is not a criterion: ${found.join(' | ')}`);
    assert.ok(found.some((entry) => /Include these timestamps/.test(entry)));
  });

  /** A condition split across two lines must still open the block. */
  it('survives a line-wrapped WHEN', () => {
    const wrapped = [
      'Table Tuning GIVEN QR Manager User is on the QR Manager',
      'Dashboard',
      'WHEN QR Manager User opens the Settlement',
      'Report menu',
      'THEN the system must fulfill:',
      'Perform Table Tuning to optimize data retrieval process',
    ].join('\n');

    assert.ok(criteria(wrapped).some((entry) => /Perform Table Tuning/.test(entry)));
  });

  it('keeps the criterion traceable to its own line', () => {
    const description = block('Include these timestamps inside the report file');

    for (const entry of typed(description, 'criterion')) {
      assert.ok(description.includes(entry.source_basis), entry.source_basis);
    }
  });

  it('is covered by a case that rephrases it', () => {
    const description = block(
      'Maintain the Export to TXT button status as active and enabled under all data states'
    );

    assert.deepEqual(
      matchObligations(derive(description), [
        testCase(
          'Verify the Export to TXT button status under all data states.',
          'The Export to TXT button remains active and enabled under all data states.'
        ),
      ]).filter((entry) => entry.type === 'criterion' && !entry.covered),
      []
    );
  });

  /**
   * The negatives, which is where a catch-all detector earns its place. Every
   * protection the earlier iterations added has to survive it.
   */
  it('reads nothing from a heading, a table row or a title', () => {
    for (const line of [
      'Document Approval',
      'Name Title Project Role Signature',
      'Aldis Furqoni Tech Lead Tech Lead',
      'Background',
      'DATE AND TIME to the table',
    ]) {
      assert.deepEqual(criteria(block(line)), [], line);
    }
  });

  it('reads nothing from another lead-in', () => {
    assert.deepEqual(
      criteria(
        block('Process and render the data according to the selected filter within the period:')
      ),
      []
    );
  });

  /** Outside a GIVEN/WHEN/THEN block nothing is a criterion, however worded. */
  it('reads nothing from background or objective prose', () => {
    const prose = [
      'Background',
      'The QR Manager application serves as the core platform for managing settlement.',
      'Objective',
      'Improve report rendering through database tuning and updated page limits',
      'Automate the daily generation and transfer of settlement report files',
      'Ensure the export button is always functional',
    ].join('\n');

    assert.deepEqual(criteria(prose), [], 'no THEN block, so no criteria');
  });

  it('reads nothing from a GIVEN or WHEN line itself', () => {
    for (const entry of criteria(block('Ensure to load all available data'))) {
      assert.doesNotMatch(entry, /^(?:GIVEN|WHEN)\b/i, entry);
    }
  });

  /** An IF/THEN bullet is a branch; counting it twice inflates the denominator. */
  it('leaves an IF/THEN bullet to the branch detector', () => {
    const description = block(
      'IF the User pick Settled filter, then display all of the settled transaction'
    );

    assert.deepEqual(criteria(description), []);
    assert.equal(typed(description, 'branch').length, 1, 'still exactly one branch');
  });

  /** And a line a specific detector already read is not counted again. */
  it('yields to a more specific reading of the same line', () => {
    const description = block(
      'Display a Select All checkbox on the page near the transaction list table'
    );

    assert.equal(typed(description, 'ui_action').length, 1, 'the UI reading is kept');
    assert.deepEqual(criteria(description), [], 'and the criterion is not counted beside it');
  });

  /** A vague quality is still a criterion, and still excused rather than chased. */
  it('marks an unquantified criterion not measurable instead of inventing a threshold', () => {
    const [entry] = typed(block('Load and display the transaction data grid quickly'), 'criterion');

    assert.ok(entry);
    assert.equal(classifyMeasurability(entry).measurable, false);
  });
});

describe('text the parser broke, and rows from the issue tracker', () => {
  const block = (...lines) =>
    [
      'GIVEN the user is on the Settlement Report menu',
      'WHEN the user opens it',
      'THEN the system must fulfill:',
      ...lines,
    ].join('\n');

  const criteria = (description) =>
    typed(description, 'criterion').map((entry) => entry.metadata.criterion);

  /**
   * Letter-spaced headings shatter in extraction, and the real document's Jira
   * titles carry "Make", "Set" and "Add" - so a verb vocabulary alone accepted
   * four of them, each demanding that QA test a ticket title.
   */
  it('reads nothing from a letter-spaced title', () => {
    for (const line of [
      'Report] Set Def ault View, Impl ement Paginati on and Add Ne w Column on T ransaction Dat a Done',
      'Report] Make t he Export Butto n Always Activ e Done',
      'Report] Add Ne w Advance Sea rch Filter Done',
    ]) {
      assert.deepEqual(criteria(block(line)), [], line);
    }
  });

  it('reads nothing from a row carrying a workflow status', () => {
    for (const line of [
      'Redefine Time out Transaction Logic via Check Status Done',
      'Improvement QR Manager Settlement Report Ready to SIT',
      'Add pagination to the transaction table IN PROGRESS',
    ]) {
      assert.deepEqual(criteria(block(line)), [], line);
    }
  });

  it('reads nothing from a fragment of a bracketed project prefix', () => {
    assert.deepEqual(
      criteria(block('Report] Add a new dropdown field named Settlement Status')),
      []
    );
  });

  /**
   * The negatives that keep this from becoming a blunt instrument. A stray
   * capital in an otherwise clean sentence is not damage, brackets that open and
   * close are ordinary punctuation, and "done" inside a sentence is a verb.
   */
  it('keeps a criterion containing a bracketed aside', () => {
    assert.deepEqual(
      criteria(
        block(
          'Ensure the process runs automatically without normal intervention and without creating temporary files (.tmp) during extraction'
        )
      ),
      [
        'Ensure the process runs automatically without normal intervention and without creating temporary files (.tmp) during extraction',
      ]
    );
  });

  it('keeps a criterion naming a single-letter column', () => {
    assert.deepEqual(criteria(block('Include column A in the generated report file')), [
      'Include column A in the generated report file',
    ]);
  });

  it('keeps a criterion whose wording merely contains the word done', () => {
    assert.deepEqual(
      criteria(block('Ensure the export is done before the scheduler releases the next batch')),
      ['Ensure the export is done before the scheduler releases the next batch']
    );
  });

  /** An unobservable quality is a criterion, and excused rather than chased. */
  it('marks a criterion that only promises correctness as not measurable', () => {
    const [entry] = typed(
      block('SysAdmin), so transfer data process can works properly'),
      'criterion'
    );

    assert.ok(entry, 'still derived, because the document said it');
    assert.equal(classifyMeasurability(entry).measurable, false);
  });
});
