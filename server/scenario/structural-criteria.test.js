import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deriveCoverageObligations } from './obligations.js';

/**
 * Acceptance criteria read by their place in a GIVEN/WHEN/THEN block, and the
 * furniture that sits in the same place without stating behaviour.
 *
 * On the real PRD the report-format block's own rows derived nothing: "Read
 * SETTLEMENT_STATUS and SETTLEMENT_GROUP_ID from source table
 * qr_settlement_group", "Key join : FT_NUMBER ..." and "Select all transaction
 * rows ..." name no verb on the criterion list, so the generator was never told
 * about the source tables, the join key or SETTLEMENT_TIME and wrote them in one
 * run of five. The delimiter row arrived joined to the file-name row and was read
 * as part of it. Given their own obligations, the same frozen fixture produced
 * them in most runs.
 *
 * Reading a row by its place is the broad move, so most of this file is the
 * other direction: headings, scenario titles, rationale, scope notes, status-quo
 * text, tracker rows and wrapped lead-ins sit in the same place and must stay out,
 * and a capital after a bracket must not cut a sentence in two. Texts are the real
 * PRD's lines where a test says so; the rest are constructed, in English and
 * Indonesian, to cover shapes that document does not happen to contain.
 *
 * Residuals that are known and not fixed are kept as todo tests, so they are
 * reported rather than forgotten.
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
const flat = (text) => String(text).replace(/\s+/g, ' ').trim();
const touching = (obligations, row) =>
  obligations.filter(
    (entry) =>
      flat(row).includes(flat(entry.source_basis)) || flat(entry.source_basis).includes(flat(row))
  );
const criteria = (obligations) => obligations.filter((entry) => entry.type === 'criterion');
const listed = (obligations) =>
  obligations.map((entry) => `${entry.type}: ${entry.statement}`).join('\n');

const OPEN = [
  'GIVEN the batch has finished',
  'WHEN the operations user opens the monitor page',
  'THEN the system must fulfill:',
];

// The real PRD's report-format scenario, as structuring rebuilds it.
const REPORT_FORMAT = [
  'GIVEN all transactions for the D-1 (previous day from 00.00-23.59) have concluded',
  'WHEN the system clock reaches 03.00 AM / off- peak hours',
  'THEN the system must fulfill:',
  'Create and implement new automated scheduler to trigger the daily report generation',
  'Use SETTLEMENT_QRMANAGER_DDMMYYYY.txt as file name format (Date using Transaction Date) Generate the final report file in .txt format using a tilde ~ as the data delimiter',
  'Save the final .txt file into a designated directory path on QR Manager server so its ready to be fetched by Reconciliation team.',
  'Report format to be generated as shown below:',
  'GIVEN the daily settlement report is generated',
  'WHEN the report file is produced',
  'THEN the system must fulfill:',
  'Generate the report with exactly these 17 columns in order: TRX_DATE, SETTLEMENT_DATE, RETRIEVAL_REF_NUM, MERCHANT_ID, PAN, MERCHANT_NAME, MERCHANT_CRITERIA, MERCHANT_SETTLEMENT_TYPE, TO_ACCOUNT, AMOUNT, CHARGE_AMOUNT, AMOUNT_SETTLEMENT, FT_NUMBER_SETTLEMENT, SWITCHING_NAME, ID_GROUP, SETTLEMENT_STATUS, SETTLEMENT_GROUP_ID',
  'Read TRX_DATE, RETRIEVAL_REF_NUM, MERCHANT_ID, PAN, MERCHANT_NAME, MERCHANT_CRITERIA, MERCHANT_SETTLEMENT_TYPE, TO_ACCOUNT, AMOUNT, CHARGE_AMOUNT, AMOUNT_SETTLEMENT, FT_NUMBER_SETTLEMENT, SWITCHING_NAME and ID_GROUP from source table v_qr_release_settlement',
  'Read SETTLEMENT_STATUS and SETTLEMENT_GROUP_ID from source table qr_settlement_group',
  'Read report column SETTLEMENT_DATE from source table qr_settlement_group source column SETTLEMENT_TIME',
  'Write TRX_DATE and SETTLEMENT_DATE in format DD-MMM-YY',
  'Write AMOUNT, CHARGE_AMOUNT and AMOUNT_SETTLEMENT as Decimal 2 digits',
  'Key join : FT_NUMBER on table qr_settlement_group dan FT_NUMBER_SETTLEMENT on table v_qr_release_settlement',
  '[Validation] Data only contains with FT_NUMBER, otherwise the data is not streamed.',
];

// The real PRD's Tick All scenario.
const TICK_ALL = [
  'GIVEN the QR Manager user is on the Settlement Report page',
  'WHEN the user clicks the Release action button (Settlement Type: HOLD)',
  'THEN the system must fulfill the following:',
  'Display a Select All checkbox on the page near the transaction list table',
  'Select all transaction rows in the table when the user checks the Select All box',
  'Unselect all transaction rows in the table when the user unchecks the Select All box',
  'Notes: Select All only applies to transactions on the current active page (up to 10 rows per page) and will not select items on other pages',
];

describe('the rows the real PRD states without a listed verb', () => {
  const report = derive(...REPORT_FORMAT);
  const stated = (needle) => report.some((entry) => entry.statement.includes(needle));

  it('derives each Read row with its source table', () => {
    assert.ok(
      stated('Read SETTLEMENT_STATUS and SETTLEMENT_GROUP_ID from source table qr_settlement_group')
    );
    assert.ok(
      stated(
        'Read report column SETTLEMENT_DATE from source table qr_settlement_group source column SETTLEMENT_TIME'
      )
    );
    assert.ok(stated('Read TRX_DATE, RETRIEVAL_REF_NUM'));
  });

  it('derives the key join', () => {
    assert.ok(
      stated(
        'Key join : FT_NUMBER on table qr_settlement_group dan FT_NUMBER_SETTLEMENT on table v_qr_release_settlement'
      )
    );
  });

  it('cuts the delimiter row from the file-name row it was joined to', () => {
    const delimiter = criteria(report).find((entry) =>
      entry.source_basis.startsWith('Generate the final report file in .txt format using a tilde ~')
    );
    assert.ok(delimiter, listed(report));
    const fileName = report.find((entry) => entry.type === 'qualifier');
    assert.equal(
      flat(fileName.source_basis),
      'Use SETTLEMENT_QRMANAGER_DDMMYYYY.txt as file name format (Date using Transaction Date)'
    );
  });

  it('keeps the obligations the block already had', () => {
    assert.ok(stated('Generate the report with exactly these 17 columns in order'));
    assert.ok(stated('Write TRX_DATE and SETTLEMENT_DATE in format DD-MMM-YY'));
    assert.ok(stated('Write AMOUNT, CHARGE_AMOUNT and AMOUNT_SETTLEMENT as Decimal 2 digits'));
    assert.ok(stated('Create and implement new automated scheduler'));
    assert.ok(report.some((entry) => entry.type === 'branch' && /otherwise/.test(entry.statement)));
  });

  it('derives Select All and Unselect All', () => {
    const tick = derive(...TICK_ALL);
    assert.equal(
      touching(
        tick,
        'Select all transaction rows in the table when the user checks the Select All box'
      ).length,
      1
    );
    assert.equal(
      touching(
        tick,
        'Unselect all transaction rows in the table when the user unchecks the Select All box'
      ).length,
      1
    );
  });

  it('declarative and passive rows count as well as imperative ones', () => {
    const rows = [
      '- The disbursement date is recorded as the value date of the loan',
      '- The installment schedule is calculated using the flat interest method',
      "- An SMS notification is sent to the borrower's registered mobile number",
      '- Each row shows the loan ID, borrower name, amount and status',
      '- The list is sorted by disbursement time, newest first',
    ];
    const obligations = derive(...OPEN, ...rows);
    for (const row of rows) assert.equal(touching(obligations, row).length, 1, row);
  });

  it('reads Indonesian passive rows', () => {
    const rows = [
      '- Notifikasi push dikirim ke perangkat nasabah',
      '- Riwayat pemblokiran dicatat pada log audit',
    ];
    const obligations = derive(
      'DIBERIKAN nasabah memiliki kartu debit berstatus Aktif',
      'KETIKA nasabah memilih menu Blokir Kartu',
      'MAKA sistem harus memenuhi:',
      ...rows
    );
    for (const row of rows) assert.equal(touching(obligations, row).length, 1, row);
  });
});

describe('a GIVEN line', () => {
  it('is never itself a criterion, whatever its verb (the real PRD line)', () => {
    const report = derive(...REPORT_FORMAT);
    assert.equal(touching(report, 'GIVEN the daily settlement report is generated').length, 0);
  });

  it('keeps both scenarios when each has GIVEN, WHEN and THEN', () => {
    const obligations = derive(
      ...OPEN,
      '- Display the total accrued interest per product',
      'GIVEN the job failed',
      'WHEN the operations user opens the monitor page',
      'THEN the system must fulfill:',
      '- Display the failure reason next to the job'
    );
    assert.equal(touching(obligations, 'Display the total accrued interest per product').length, 1);
    assert.equal(touching(obligations, 'Display the failure reason next to the job').length, 1);
  });

  it('opens a GIVEN -> THEN scenario with no WHEN, with the GIVEN clause as its condition', () => {
    const obligations = derive(
      ...OPEN,
      '- Display the total accrued interest per product',
      'GIVEN the accrual job is still running',
      'THEN the system must fulfill:',
      '- Display a progress bar with the number of processed accounts',
      '- The Download button is disabled until the job finishes'
    );
    const progress = touching(
      obligations,
      'Display a progress bar with the number of processed accounts'
    );
    assert.equal(progress.length, 1, listed(obligations));
    assert.equal(progress[0].metadata.condition, 'the accrual job is still running');
    assert.equal(
      touching(obligations, 'The Download button is disabled until the job finishes').length,
      1,
      listed(obligations)
    );
  });

  it('leaves the condition to a WHEN when there is one', () => {
    const [entry] = touching(
      derive(...OPEN, '- Display the batch status'),
      'Display the batch status'
    );
    assert.equal(entry.metadata.condition, 'the operations user opens the monitor page');
  });

  it('opens a DIBERIKAN -> MAKA scenario with no KETIKA', () => {
    const obligations = derive(
      'DIBERIKAN kartu debit berstatus Blokir Sementara',
      'KETIKA nasabah memilih menu Buka Blokir',
      'MAKA sistem harus memenuhi:',
      '- Tampilkan formulir PIN transaksi',
      'DIBERIKAN kartu debit berstatus Blokir Permanen',
      'MAKA sistem harus memenuhi:',
      '- Nasabah diarahkan untuk menghubungi call center 1500-153'
    );
    assert.equal(
      touching(obligations, 'Nasabah diarahkan untuk menghubungi call center 1500-153').length,
      1,
      listed(obligations)
    );
  });

  it('gives a GIVEN -> THEN outcome line the GIVEN condition', () => {
    const obligations = derive(
      'DIBERIKAN saldo rekening kurang dari biaya admin',
      'MAKA transaksi ditolak dengan kode 51'
    );
    assert.ok(
      obligations.some(
        (entry) =>
          entry.type === 'branch' &&
          entry.statement.includes('saldo rekening kurang dari biaya admin')
      ),
      listed(obligations)
    );
  });

  it('reads a sentence-case Given / When / Then scenario', () => {
    const obligations = derive(
      'Given the customer is logged in',
      'When the customer opens the card menu',
      'Then the system must fulfill:',
      '- The card status is shown next to the card number',
      'Given the card is blocked',
      'Then the system must fulfill:',
      '- The Unblock button is shown under the card'
    );
    assert.equal(
      touching(obligations, 'The card status is shown next to the card number').length,
      1
    );
    assert.equal(touching(obligations, 'The Unblock button is shown under the card').length, 1);
    assert.equal(touching(obligations, 'Given the card is blocked').length, 0);
  });

  it('does not close a list at a row that only begins with the word Given', () => {
    const obligations = derive(
      'GIVEN that a GL posting is rejected',
      'WHEN the accrual job receives the rejection',
      'THEN the system must fulfill:',
      '- Mark the accrual record as FAILED',
      '- Given a pending change exists, the new request replaces it',
      '- Send an email alert to the operations team'
    );
    assert.equal(
      touching(obligations, 'Given a pending change exists, the new request replaces it').length,
      1
    );
    assert.equal(touching(obligations, 'Send an email alert to the operations team').length, 1);
  });

  const RETRY_PROSE = [
    'GIVEN that a GL posting is rejected by the core banking system',
    'WHEN the accrual job receives the rejection',
    'THEN the system must fulfill:',
    '- Mark the accrual record as FAILED',
    '- The failed posting is retried once after 30 minutes',
    '- Given the retry also fails, the record is moved to the exception queue',
    '- Send an email alert to the operations team',
  ];

  it('keeps the rows after a prose Given that mentions a retry', () => {
    assert.equal(
      touching(derive(...RETRY_PROSE), 'Send an email alert to the operations team').length,
      1
    );
  });

  it(
    'derives the prose Given row itself when it mentions a retry',
    {
      todo: 'the retry reading wins reconcile over the criterion and is then removed as a duplicate retry statement',
    },
    () => {
      const obligations = derive(...RETRY_PROSE);
      assert.equal(
        touching(
          obligations,
          'Given the retry also fails, the record is moved to the exception queue'
        ).length,
        1
      );
    }
  );
});

describe('furniture in a THEN list', () => {
  it('rejects Title Case headings, with or without function words', () => {
    const obligations = derive(
      ...OPEN,
      '- Display the batch status',
      'Release Settlement Approval',
      'Release of the Settlement Approval'
    );
    assert.equal(
      touching(obligations, 'Release Settlement Approval').length,
      0,
      listed(obligations)
    );
    assert.equal(
      touching(obligations, 'Release of the Settlement Approval').length,
      0,
      listed(obligations)
    );
  });

  it('rejects a scenario title directly above the next GIVEN', () => {
    for (const title of [
      'Handling of failed postings',
      'Handling of expired and locked sessions',
    ]) {
      const obligations = derive(
        ...OPEN,
        '- The upload summary is listed by employee',
        title,
        'GIVEN the maker session has expired',
        'WHEN the maker submits the upload',
        'THEN the system must fulfill:',
        '- No payroll batch is created'
      );
      assert.equal(touching(obligations, title).length, 0, `${title}\n${listed(obligations)}`);
    }
  });

  it('keeps a row that ends a list right before the next scenario', () => {
    const artifact = derive(
      ...OPEN,
      '- Read BRANCH_CODE from mst_branch',
      'GIVEN the job failed',
      'WHEN the user opens the page',
      'THEN the system must fulfill:',
      '- Display the failure reason'
    );
    assert.equal(
      touching(artifact, 'Read BRANCH_CODE from mst_branch').length,
      1,
      listed(artifact)
    );
    const predicate = derive(
      ...OPEN,
      '- The account is not created',
      'WHEN the user retries',
      'THEN the system must fulfill:',
      '- Display the failure reason'
    );
    assert.equal(touching(predicate, 'The account is not created').length, 1, listed(predicate));
  });

  it('rejects a comment on the rows above, but keeps a demonstrative row', () => {
    const obligations = derive(
      ...OPEN,
      '- The beneficiary name is entered by the customer',
      '- This field is mandatory for every transfer',
      'This reduces drop-off during onboarding.'
    );
    assert.equal(touching(obligations, 'This field is mandatory for every transfer').length, 1);
    assert.equal(touching(obligations, 'This reduces drop-off during onboarding.').length, 0);
  });

  it('rejects a statement of purpose, but keeps a row about a reason code', () => {
    const obligations = derive(
      ...OPEN,
      '- The reason code is shown on the biller dashboard when creation fails',
      'The goal is to reduce manual reconciliation effort.',
      'Tujuan perubahan ini adalah mempercepat persetujuan.'
    );
    assert.equal(
      touching(obligations, 'The reason code is shown on the biller dashboard when creation fails')
        .length,
      1
    );
    assert.equal(
      criteria(touching(obligations, 'The goal is to reduce manual reconciliation effort.')).length,
      0
    );
    assert.equal(
      criteria(touching(obligations, 'Tujuan perubahan ini adalah mempercepat persetujuan.'))
        .length,
      0
    );
  });

  it('rejects scope, exclusion, assumption and caption lines', () => {
    const notes = [
      'Out of scope for this phase: joint accounts and video KYC',
      'Not included in this release: payroll reversal and bulk cancellation',
      'Di luar cakupan: aktivasi melalui aplikasi mobile',
      'Assumption: the core banking system is available 24/7',
      'Figure 2: Masked receipt sample',
    ];
    const obligations = derive(...OPEN, '- The account number is masked on the receipt', ...notes);
    for (const note of notes) assert.equal(criteria(touching(obligations, note)).length, 0, note);
  });

  it('rejects a line about how the system behaves today (the real PRD lines)', () => {
    const obligations = derive(
      'WHEN QR Manager User opens the Settlement',
      'Report menu',
      'THEN the system must fulfill:',
      'Perform Table Tuning to optimize data retrieval process',
      'Load and display the transaction data grid quickly',
      'Current condition in production when opening',
      'Settlement Report menu (cost 28 seconds):'
    );
    assert.equal(touching(obligations, 'Current condition in production when opening').length, 0);
    assert.equal(
      touching(obligations, 'Load and display the transaction data grid quickly').length,
      1
    );
  });

  it('rejects tracker rows and the title fragment after them', () => {
    const obligations = derive(
      'Scenario Acceptance Criteria Jira Link',
      ...OPEN,
      '- The account number is displayed on the confirmation screen',
      'ONB-1123: Identity capture and validation',
      'Selfie liveness check'
    );
    assert.equal(
      criteria(obligations).filter((entry) =>
        /ONB-1123|Selfie liveness check/.test(entry.source_basis)
      ).length,
      0,
      listed(obligations)
    );
  });

  it('stops reading rows by place after a lead-in that introduces no conditions', () => {
    const obligations = derive(
      ...OPEN,
      '- The refund reference number is shown on the receipt',
      '- Map the switching response code as follows:',
      '- 00 -> Refund Success',
      '- Merchant refund screen layout'
    );
    assert.equal(touching(obligations, 'Merchant refund screen layout').length, 0);
    assert.equal(touching(obligations, 'Map the switching response code as follows:').length, 0);
  });

  it('keeps reading after a lead-in that introduces IF rows', () => {
    const obligations = derive(
      ...OPEN,
      '- Process the refund according to the original payment channel:',
      '- IF the customer paid with an e-wallet, then credit the refund to the same e-wallet',
      '- The refund reference number is shown on the refund receipt'
    );
    assert.equal(
      touching(obligations, 'The refund reference number is shown on the refund receipt').length,
      1
    );
  });

  it('reads a wrapped lead-in as a lead-in, not its first line as a row', () => {
    for (const continuation of ['fields:', 'Fields:']) {
      const obligations = derive(
        ...OPEN,
        '- The refund history is listed by date',
        '- The summary panel contains the following',
        continuation
      );
      assert.equal(
        touching(obligations, 'The summary panel contains the following').length,
        0,
        continuation
      );
    }
  });

  it('keeps a finished row that happens to sit above a lead-in row', () => {
    const obligations = derive(
      ...OPEN,
      '- Refund amount cannot exceed the original transaction amount',
      '- Process the refund according to the original payment channel:',
      '- IF the customer paid with an e-wallet, then credit the refund to the same e-wallet'
    );
    assert.equal(
      touching(obligations, 'Refund amount cannot exceed the original transaction amount').length,
      1,
      listed(obligations)
    );
  });

  it('does not read an IF/THEN row or an otherwise row as a criterion as well as a branch', () => {
    assert.equal(
      criteria(
        derive(
          ...OPEN,
          '- IF the customer paid with a debit card, then credit the refund within 3 business days'
        )
      ).length,
      0
    );
    assert.equal(
      criteria(
        derive(
          ...OPEN,
          '- A liveness score of 0.80 or higher passes the check, otherwise the customer is asked to retake the selfie'
        )
      ).length,
      0
    );
  });

  it(
    'rejects a Title Case heading whose noun is also a listed verb',
    {
      todo: 'the CRITERION_VERB path reads "Display" in a heading; not changed by structural reading',
    },
    () => {
      const obligations = derive(
        ...OPEN,
        '- Display the batch status',
        'Row Display and Pagination Limit'
      );
      assert.equal(touching(obligations, 'Row Display and Pagination Limit').length, 0);
    }
  );

  it(
    'rejects a status-quo line that also carries a listed verb',
    { todo: 'the CRITERION_VERB path ("export") admits it before any structural rule is applied' },
    () => {
      const obligations = derive(
        ...OPEN,
        '- Load and display the export history quickly',
        'Currently the export takes 40 seconds when opening',
        'Export History page (cost 40 seconds):'
      );
      assert.equal(
        criteria(touching(obligations, 'Currently the export takes 40 seconds when opening'))
          .length,
        0
      );
    }
  );

  it(
    'rejects other annotation labels',
    { todo: 'annotation-label vocabulary is open-ended: "Benefits:" is read as a row' },
    () => {
      const obligations = derive(
        ...OPEN,
        '- The receipt shows the remaining daily limit',
        'Benefits: fewer disputes at branch counters'
      );
      assert.equal(
        criteria(touching(obligations, 'Benefits: fewer disputes at branch counters')).length,
        0
      );
    }
  );
});

describe('a row the extractor joined after a bracket', () => {
  it('is cut when both sides are rows of their own', () => {
    for (const [row, second] of [
      [
        'Validate the NIK against the population registry (Dukcapil) Registry response must be received within 5 seconds',
        'Registry response must be received within 5 seconds',
      ],
      [
        'Show the refund status (Pending, Success, Failed) Export the list to CSV when requested',
        'Export the list to CSV when requested',
      ],
      [
        'Match the payment amount with the bill amount (exact match) Partial payments are refused',
        'Partial payments are refused',
      ],
    ]) {
      const obligations = derive(...OPEN, `- ${row}`);
      assert.ok(
        obligations.some((entry) => flat(entry.source_basis) === second),
        `${row}\n${listed(obligations)}`
      );
    }
  });

  it('is not cut after an abbreviation that glosses the name before it', () => {
    for (const [row, kept] of [
      ['One-time password (OTP) Verification is required before the selfie step', 'OTP'],
      [
        'Funds Transfer (FT) Success message is displayed to the customer',
        'Funds Transfer (FT) Success message',
      ],
      ['The Customer Information File (CIF) Number is printed on the receipt', 'CIF'],
      [
        'Real Time Gross Settlement (RTGS) Transfers above IDR 100,000,000 are routed to the RTGS queue',
        'Real Time Gross Settlement (RTGS)',
      ],
      ['Personal Identification Number (PIN) Validation happens before the amount screen', 'PIN'],
    ]) {
      const found = criteria(derive(...OPEN, `- ${row}`));
      assert.equal(found.length, 1, `${row}\n${listed(found)}`);
      assert.equal(flat(found[0].source_basis), row);
      assert.ok(found[0].statement.includes(kept), found[0].statement);
    }
  });

  it('is not cut when either side is not a row of its own', () => {
    const time = derive(
      ...OPEN,
      '- Send the daily file to the reconciliation team (via SFTP) Monday to Friday before 07.00'
    );
    assert.ok(
      !time.some((entry) => flat(entry.source_basis) === 'Monday to Friday before 07.00'),
      listed(time)
    );
    const name = derive(
      ...OPEN,
      '- Bank Indonesia Fast Payment (real-time) Transfer limit is IDR 250,000,000 per transaction'
    );
    assert.ok(
      !name.some((entry) => flat(entry.source_basis).startsWith('Transfer limit is')),
      listed(name)
    );
  });

  it('leaves a mapping row with a bracketed meaning whole', () => {
    const obligations = derive(
      'Response Mapping',
      '00 -> Funds Transfer (FT) Success (Transaction successfully processed in core)'
    );
    assert.ok(
      !obligations.some((entry) => /^Success \(Transaction/.test(flat(entry.source_basis)))
    );
  });

  it(
    'is cut when the first row is short',
    {
      todo: 'needs two lowercase content words before the bracket; the row stays whole, no text lost',
    },
    () => {
      const obligations = derive(
        ...OPEN,
        '- Dispense the notes (largest denomination first) Print the receipt after the cash is taken'
      );
      assert.ok(
        obligations.some(
          (entry) => flat(entry.source_basis) === 'Print the receipt after the cash is taken'
        )
      );
    }
  );

  it(
    'is cut after an abbreviation that ends a row',
    { todo: 'an abbreviation bracket is never cut after; the row stays whole, no text lost' },
    () => {
      const obligations = derive(
        ...OPEN,
        '- Send the file via Secure File Transfer Protocol (SFTP) Files are encrypted with PGP before transfer'
      );
      assert.ok(
        obligations.some((entry) =>
          flat(entry.source_basis).startsWith('Files are encrypted with PGP')
        )
      );
    }
  );
});

describe('an otherwise branch', () => {
  it('states the condition it negates (the real PRD line)', () => {
    const branch = derive(...REPORT_FORMAT).find(
      (entry) => entry.type === 'branch' && /otherwise/.test(entry.statement)
    );
    assert.equal(
      branch.statement,
      'Branch - otherwise: the data is not streamed, as stated: [Validation] Data only contains with FT_NUMBER, otherwise the data is not streamed.'
    );
    assert.equal(branch.metadata.condition, 'otherwise');
    assert.equal(branch.metadata.outcome, 'the data is not streamed');
  });

  it('keeps the outcome first, in the polarity the source states it', () => {
    const branch = derive(
      ...OPEN,
      '- A liveness score of 0.80 or higher passes the check, otherwise the customer is asked to retake the selfie'
    ).find((entry) => entry.type === 'branch' && /otherwise/.test(entry.statement));
    assert.match(
      branch.statement,
      /^Branch - otherwise: the customer is asked to retake the selfie, as stated: /
    );
    assert.ok(branch.statement.includes('0.80 or higher passes the check'));
  });

  it('adds nothing when no condition precedes it', () => {
    const branch = derive(...OPEN, '- Otherwise, keep the Continue button disabled').find(
      (entry) => entry.type === 'branch'
    );
    assert.ok(!branch || !/as stated/.test(branch.statement));
  });

  it('stays within the schema limit on a long sentence', () => {
    const branch = derive(
      ...OPEN,
      '- When the beneficiary bank is offline and the transfer was submitted after the 15.00 cut-off on the last business day of the month, the transfer is queued for the next business day and the customer is informed on the confirmation page, otherwise the transfer is processed immediately through the online channel.'
    ).find((entry) => entry.type === 'branch' && /otherwise/.test(entry.statement));
    assert.ok(branch.statement.length <= 300);
    assert.ok(branch.statement.includes('15.00 cut-off'));
  });

  it(
    'carries the condition of an Otherwise that starts its own sentence',
    { todo: 'only the sentence holding the otherwise is read' },
    () => {
      const branch = derive(
        ...OPEN,
        '- If the OTP matches, the transfer is executed. Otherwise the transfer is cancelled.'
      ).find((entry) => entry.type === 'branch' && /otherwise/.test(entry.statement));
      assert.ok(branch.statement.includes('OTP'));
    }
  );

  it(
    'is not read out of "if not" or Indonesian "selain itu" (in addition)',
    { todo: 'ELSE_RULE lists both; predates the structural reading' },
    () => {
      const ifNot = derive(
        ...OPEN,
        '- Retry the registry call once if not answered within 5 seconds'
      );
      assert.ok(!ifNot.some((entry) => /otherwise: answered/.test(entry.statement)));
      const selain = derive(
        'DIBERIKAN nasabah memiliki kartu aktif',
        'KETIKA nasabah memblokir kartu',
        'MAKA sistem harus memenuhi:',
        '- Selain itu, sistem mengirim email konfirmasi ke nasabah'
      );
      assert.ok(!selain.some((entry) => /otherwise/.test(entry.statement)));
    }
  );
});

describe('a criterion statement', () => {
  it('keeps the option a wrapped criterion ends on (the real PRD lines)', () => {
    const obligations = derive(
      'WHEN User click Advance Search filter dropdown',
      'THEN the system must fulfill the following:',
      'Add a new dropdown field named Settlement',
      'Status: placed directly below the existing',
      'Settlement Type: dropdown: Settled ,',
      'Unsettled , and Settled & Unsettled'
    );
    const [dropdown] = criteria(obligations);
    assert.ok(dropdown.statement.endsWith('Settled & Unsettled'), dropdown.statement);
  });

  it('keeps a 240-character row whole', () => {
    const [entry] = criteria(
      derive(
        ...OPEN,
        '- Write the accrual summary with these columns in order: ACCOUNT_NO, CIF_NO, PRODUCT_CODE, BRANCH_CODE, CURRENCY, BALANCE_D1, TIER, RATE, ACCRUED_INTEREST, TAX_AMOUNT, NET_INTEREST, VALUE_DATE, POSTING_DATE, GL_ACCOUNT, BATCH_ID, STATUS, REMARK'
      )
    );
    assert.ok(entry.statement.includes('REMARK'), entry.statement);
  });

  it('is cut, never dropped, past the 300 characters the schema allows', () => {
    const [entry] = criteria(
      derive(
        ...OPEN,
        '- Write the accrual summary with these columns in order: ACCOUNT_NO, CIF_NO, PRODUCT_CODE, BRANCH_CODE, CURRENCY, BALANCE_D1, TIER, RATE, ACCRUED_INTEREST, TAX_AMOUNT, NET_INTEREST, VALUE_DATE, POSTING_DATE, GL_ACCOUNT, BATCH_ID, STATUS, REMARK, CREATED_BY, CREATED_AT, UPDATED_BY, UPDATED_AT, APPROVED_BY, APPROVED_AT'
      )
    );
    assert.ok(entry, 'the criterion must not be dropped');
    assert.equal(entry.statement.length, 300);
    assert.ok(entry.statement.endsWith('…'));
  });

  it(
    'is derived from a row whose text exceeds 1000 characters',
    {
      todo: 'obligationSchema rejects source_basis over 1000 characters and the obligation is dropped',
    },
    () => {
      const huge = `Write the export with the columns ${Array.from({ length: 110 }, (_, i) => `COLUMN_${i + 1}`).join(', ')} in that order`;
      assert.equal(criteria(derive(...OPEN, `- ${huge}`)).length, 1);
    }
  );
});

describe('the 16-obligation ceiling', () => {
  it('keeps 16 and reports the rest through onTruncate', () => {
    const reports = [];
    const obligations = deriveCoverageObligations(
      [
        requirement(
          [
            ...OPEN,
            ...Array.from(
              { length: 20 },
              (_, i) => `- Display report column COLUMN_${i + 1} in the summary table`
            ),
          ].join('\n')
        ),
      ],
      { onTruncate: (report) => reports.push(report) }
    );
    assert.equal(obligations.length, 16);
    assert.deepEqual(reports, [{ requirement_id: 'REQ-001', dropped: 4 }]);
  });

  it('is not reached by a dense requirement whose brackets and headings are read correctly', () => {
    const reports = [];
    const obligations = deriveCoverageObligations(
      [
        requirement(
          [
            ...OPEN,
            '- Real Time Gross Settlement (RTGS) Transfers above IDR 100,000,000 are routed to the RTGS queue',
            '- Funds Transfer (FT) Success message is displayed to the customer',
            '- The Customer Information File (CIF) Number is printed on the receipt',
            '- Show the Continue button only when all mandatory fields are valid, otherwise keep it disabled',
            '- Retry the registry call once if not answered within 5 seconds',
            '- If the OTP matches, the transfer is executed. Otherwise the transfer is cancelled and the hold is released.',
            '- When the beneficiary bank is offline and the transfer was submitted after the 15.00 cut-off on the last business day of the month, the transfer is queued for the next business day and the customer is informed on the confirmation page, otherwise the transfer is processed immediately through the online channel.',
            'Release of the Settlement Approval',
            '- Write the transfer audit record with these fields: TRX_ID, CHANNEL, AMOUNT, STATUS and REASON_CODE',
            '- Write the full regulatory export with the columns FIELD_01 to FIELD_70 in that order',
          ].join('\n')
        ),
      ],
      { onTruncate: (report) => reports.push(report) }
    );
    assert.deepEqual(reports, []);
    assert.ok(obligations.some((entry) => entry.statement.includes('REASON_CODE')));
    assert.ok(obligations.some((entry) => entry.statement.includes('FIELD_70')));
  });
});
