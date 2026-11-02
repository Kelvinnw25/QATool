import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AppError } from '../lib/errors.js';
import { extractDocuments, WARNING_CODES } from './index.js';
import { buildRequirements } from './requirements.js';
import { reconstructCriteria } from './blocks.js';
import { parsePdf } from './parsers/pdf.js';
import { detectFileType, guessDocumentType, sanitizeFilename } from './detect.js';
import { buildDocx, buildPdf, buildXlsx } from './fixtures/build.js';
import { requirementSchema } from '../schema/requirement.js';
import { documentSchema } from '../schema/document.js';
import { REQUIREMENT_CATEGORIES } from '../schema/enums.js';

/* ----------------------------------------------------------- fixtures --- */

/** A PRD in the shape the real ones take: approval boilerplate, then content. */
function prdDocx() {
  return buildDocx([
    { heading: 'Created by', level: 1 },
    {
      table: [
        ['Name', 'Title', 'Project Role', 'Signature', 'Date'],
        ['Adrian Logito', 'Section Head', 'Product Manager', '', ''],
      ],
    },
    { heading: 'Revision History', level: 1 },
    {
      table: [
        ['Version', 'Date', 'Author'],
        ['1.0', '2026-01-02', 'Keizia'],
      ],
    },
    { heading: 'Business Rules', level: 1 },
    {
      text: 'Transactions originating from a Suspended participant must be rejected with reason code U253.',
    },
    { heading: 'Validation', level: 2 },
    {
      text: 'A transfer missing a mandatory field such as BIC code must be rejected with reason code ADMI 002.',
    },
    { text: 'The timeout for participant status lookup is 30 seconds.' },
    {
      table: [
        ['Field', 'Rule', 'Notes'],
        ['Account Number', 'Mandatory, 10 digits', 'Rejected when absent'],
        ['Creditor ID', 'Optional', 'May be empty, etc.'],
      ],
    },
  ]);
}

function rfcPdf() {
  return buildPdf([
    [
      'Request For Change',
      'Batch Size Limits',
      'A batch of up to 50 transactions is accepted by the connector.',
      'The timeout for participant status lookup is 60 seconds.',
    ],
    [
      'Participant Status',
      'Transfers from an Active participant must be routed normally.',
      'Page 2 of 2',
    ],
  ]);
}

/**
 * A PDF that wraps, which is what every real one does.
 *
 * Two sentences run past the margin: one continues lowercase, the other
 * continues with a capitalised amount. Both used to be split, and the first
 * half of each was read as a heading because it is capitalised and carries no
 * full stop - which is how a documented error code went missing entirely.
 */
function wrappedPdf() {
  return buildPdf([
    [
      'Payment Submission API',
      '1.1 Amount Validation',
      'If the amount is zero or negative the API must return HTTP 400 with the error',
      'code ERR_INVALID_AMOUNT.',
      'The maximum single payment that the service accepts from a client must not exceed',
      'IDR 50,000,000 per transaction.',
      'A payment reference must be unique.',
    ],
  ]);
}

function matrixXlsx() {
  return buildXlsx([
    {
      name: 'Field Rules',
      rows: [
        ['Field', 'Validation', 'Error Code'],
        ['BIC Code', 'Mandatory, 8 or 11 characters', 'ADMI 002'],
        ['Amount', 'Must not exceed the maximum limit', 'U112'],
      ],
    },
    { name: 'Notes', rows: [['Owner'], ['Kelvin']] },
  ]);
}

const file = (filename, buffer) => ({ filename, buffer, mimetype: null });

/* ------------------------------------------------------------- detect --- */

test('file types are detected from bytes, not from the filename', () => {
  assert.equal(detectFileType(buildPdf([['x']]), 'anything.txt'), 'pdf');
  assert.equal(detectFileType(prdDocx(), 'renamed.pdf'), 'docx');
  assert.equal(detectFileType(matrixXlsx(), 'renamed.docx'), 'xlsx');
});

test('unsupported and corrupt files are rejected with controlled errors', () => {
  assert.throws(
    () => detectFileType(Buffer.from('plain text, not a document'), 'notes.txt'),
    (error) => error instanceof AppError && error.code === 'UNSUPPORTED_FILE_TYPE'
  );

  assert.throws(
    () => detectFileType(Buffer.alloc(0), 'empty.pdf'),
    (error) => error instanceof AppError && error.code === 'EMPTY_DOCUMENT'
  );

  // ZIP magic bytes followed by rubbish: looks like an Office file, is not one.
  const brokenZip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 0x41)]);
  assert.throws(
    () => detectFileType(brokenZip, 'broken.docx'),
    (error) => error instanceof AppError && error.code === 'CORRUPT_DOCUMENT'
  );
});

test('filenames are sanitised and kept as metadata only', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename('C:\\docs\\PRD Overdraft.docx'), 'PRD Overdraft.docx');
  assert.equal(sanitizeFilename(''), 'document');
});

test('document type is guessed from the filename', () => {
  assert.equal(guessDocumentType('PRD Overdraft Account.docx'), 'PRD');
  assert.equal(guessDocumentType('Request For Change - SFTP.pdf'), 'RFC');
  assert.equal(guessDocumentType('notes.xlsx'), 'Supporting Document');
});

/* -------------------------------------------------------- per format --- */

test('DOCX extraction finds requirements and records the heading path', async () => {
  const result = await extractDocuments([file('PRD Bulk Transfer.docx', prdDocx())]);

  assert.equal(result.documents[0].status, 'Extracted');
  assert.equal(result.documents[0].document_id, 'DOC-001');
  assert.ok(result.requirements.length >= 3);

  const suspended = result.requirements.find((requirement) =>
    /Suspended participant/.test(requirement.description)
  );
  assert.ok(suspended, 'the Suspended participant rule should be extracted');
  assert.equal(suspended.source_references[0].document_id, 'DOC-001');
  assert.equal(suspended.source_references[0].section, 'Business Rules');

  // Heading paths nest: a level-2 heading keeps its level-1 parent.
  const mandatory = result.requirements.find((requirement) =>
    /BIC code/.test(requirement.description)
  );
  assert.equal(mandatory.source_references[0].section, 'Business Rules > Validation');
});

test('DOCX page numbers are never fabricated', async () => {
  const result = await extractDocuments([file('PRD.docx', prdDocx())]);

  for (const requirement of result.requirements) {
    assert.equal(requirement.source_references[0].page, null);
  }
  assert.equal(result.documents[0].page_count, null);

  assert.ok(
    result.warnings.some(
      (warning) =>
        warning.code === WARNING_CODES.PARSER_LIMITATION &&
        /no fixed pagination/.test(warning.message)
    ),
    'the pagination limitation should be stated rather than worked around'
  );
});

test('DOCX table rows keep their column meaning', async () => {
  const result = await extractDocuments([file('PRD.docx', prdDocx())]);

  const accountNumber = result.requirements.find((requirement) =>
    /Account Number/.test(requirement.description)
  );
  assert.ok(accountNumber, 'the field rules table row should survive as a requirement');

  // The row must not be flattened into loose words: each value stays attached
  // to the column it came from.
  assert.match(accountNumber.description, /Field: Account Number/);
  assert.match(accountNumber.description, /Rule: Mandatory, 10 digits/);
  assert.match(accountNumber.description, /Notes: Rejected when absent/);
});

test('PDF extraction records real page numbers', async () => {
  const result = await extractDocuments([file('RFC Limits.pdf', rfcPdf())]);

  assert.equal(result.documents[0].page_count, 2);
  assert.ok(result.documents[0].extracted_char_count > 100);

  const batch = result.requirements.find((requirement) =>
    /50 transactions/.test(requirement.description)
  );
  assert.ok(batch, 'the batch size rule should be extracted');
  assert.equal(batch.source_references[0].page, 1);
  assert.equal(batch.source_references[0].section, 'Batch Size Limits');

  const active = result.requirements.find((requirement) =>
    /Active participant/.test(requirement.description)
  );
  assert.equal(active.source_references[0].page, 2, 'page 2 content must cite page 2');
});

test('a sentence wrapped across two PDF lines stays one requirement', async () => {
  const result = await extractDocuments([file('RFC Payments.pdf', wrappedPdf())]);

  const amount = result.requirements.find((requirement) =>
    /zero or negative/.test(requirement.description)
  );

  assert.ok(amount, 'the wrapped requirement should be extracted');
  assert.match(
    amount.description,
    /ERR_INVALID_AMOUNT/,
    'the continuation line belongs to the same requirement'
  );
  assert.match(amount.description, /HTTP 400/, 'the condition and its outcome stay together');
});

test('a wrapped continuation is joined even when it starts with a capital', async () => {
  const result = await extractDocuments([file('RFC Payments.pdf', wrappedPdf())]);

  const limit = result.requirements.find((requirement) =>
    /maximum single payment/.test(requirement.description)
  );

  assert.ok(limit, 'the limit requirement should be extracted');
  assert.match(
    limit.description,
    /IDR 50,000,000/,
    'a capitalised continuation is still part of the sentence'
  );
});

test('a wrapped line is never treated as a heading', async () => {
  const result = await extractDocuments([file('RFC Payments.pdf', wrappedPdf())]);

  const sections = result.requirements.flatMap((requirement) =>
    requirement.source_references.map((reference) => reference.section)
  );

  for (const section of sections) {
    assert.doesNotMatch(
      section ?? '',
      /zero or negative|must not exceed/,
      'half a sentence must never become the section a requirement is filed under'
    );
  }
});

test('real headings, numbered and titled, are still recognised', async () => {
  const result = await extractDocuments([file('RFC Payments.pdf', wrappedPdf())]);

  const sections = new Set(
    result.requirements.flatMap((requirement) =>
      requirement.source_references.map((reference) => reference.section)
    )
  );

  assert.ok(sections.has('1.1 Amount Validation'), 'a numbered heading still heads its section');
  assert.ok(
    !result.requirements.some((requirement) =>
      /^Payment Submission API$/.test(requirement.description)
    ),
    'a title-case heading is not itself a requirement'
  );
});

test('a documented error code survives extraction', async () => {
  const result = await extractDocuments([file('RFC Payments.pdf', wrappedPdf())]);

  assert.ok(
    result.requirements.some((requirement) => /ERR_INVALID_AMOUNT/.test(requirement.description)),
    'a requirement naming a documented error code must not be lost'
  );
});

test('a short fragment naming a documented code is kept and flagged, not dropped', async () => {
  const result = await extractDocuments([
    file(
      'RFC Codes.pdf',
      buildPdf([['Error Codes', 'The API rejects malformed requests.', 'ERR_INVALID_AMOUNT.']])
    ),
  ]);

  const fragment = result.requirements.find((requirement) =>
    /ERR_INVALID_AMOUNT/.test(requirement.description)
  );

  assert.ok(fragment, 'a documented identifier is never discarded for being short');
  assert.ok(
    fragment.ambiguities.some((note) => /may be missing/.test(note)),
    'and the reviewer is told the text looks incomplete'
  );
  assert.ok(
    result.warnings.some(
      (warning) =>
        warning.code === WARNING_CODES.AMBIGUOUS_REQUIREMENT &&
        /may be missing/.test(warning.message)
    ),
    'the concern reaches the warnings the user sees'
  );
});

test('XLSX extraction records sheet and cell range', async () => {
  const result = await extractDocuments([file('Field Matrix.xlsx', matrixXlsx())]);

  const bic = result.requirements.find((requirement) => /BIC Code/.test(requirement.description));
  assert.ok(bic, 'the spreadsheet row should become a requirement');
  assert.match(bic.description, /Field: BIC Code/);
  assert.match(bic.description, /Validation: Mandatory, 8 or 11 characters/);
  assert.match(bic.source_references[0].section, /^Field Rules A2:C2$/);
  assert.equal(bic.source_references[0].page, null);
});

/* ----------------------------------------------------------- filtering -- */

test('approval and revision-history boilerplate is filtered out', async () => {
  const result = await extractDocuments([file('PRD.docx', prdDocx())]);
  const text = JSON.stringify(result.requirements);

  assert.ok(!/Adrian Logito/.test(text), 'signature table must not become a requirement');
  assert.ok(!/Project Role/.test(text), 'approval columns must not become requirements');
  assert.ok(!/Revision History/.test(text), 'revision history must not become a requirement');
  assert.ok(!/Keizia/.test(text), 'revision author must not become a requirement');
});

test('filtering does not swallow real requirements', async () => {
  const result = await extractDocuments([file('PRD.docx', prdDocx())]);

  // Everything after the boilerplate must still be there.
  for (const expected of [/Suspended participant/, /BIC code/, /Account Number/]) {
    assert.ok(
      result.requirements.some((requirement) => expected.test(requirement.description)),
      `${expected} should survive noise filtering`
    );
  }
});

/* ------------------------------------------------------------ warnings -- */

test('an image-only document produces a low-text warning, not invented content', async () => {
  // A PDF whose pages carry no text at all - the shape of a scanned RFC.
  const imageOnly = buildPdf([[], []]);
  const result = await extractDocuments([
    file('Scanned RFC.pdf', imageOnly),
    file('PRD.docx', prdDocx()),
  ]);

  const scanned = result.documents.find((document) => document.filename === 'Scanned RFC.pdf');
  assert.equal(scanned.extracted_char_count, 0);
  assert.equal(scanned.status, 'Extracted', 'parsing succeeded; there was simply no text');

  const warning = result.warnings.find(
    (warning) =>
      warning.code === WARNING_CODES.LOW_EXTRACTED_TEXT &&
      warning.document_id === scanned.document_id
  );
  assert.ok(warning, 'a low-text warning is required');
  assert.match(warning.message, /no OCR|images or scans/i);

  assert.ok(
    !result.requirements.some((requirement) =>
      requirement.source_references.some(
        (reference) => reference.document_id === scanned.document_id
      )
    ),
    'no requirement may be attributed to a document with no text'
  );
});

test('documents that yield nothing produce a controlled error, never empty success', async () => {
  await assert.rejects(
    () => extractDocuments([file('Scanned.pdf', buildPdf([[]]))]),
    (error) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'NO_REQUIREMENTS_EXTRACTED');
      assert.equal(error.statusCode, 422);
      // The metrics that explain why must come back with the error.
      assert.equal(error.details[0].extracted_char_count, 0);
      return true;
    }
  );
});

test('one unreadable document does not lose the rest of the batch', async () => {
  const result = await extractDocuments([
    file('notes.txt', Buffer.from('this is not a document')),
    file('PRD.docx', prdDocx()),
  ]);

  const failed = result.documents.find((document) => document.filename === 'notes.txt');
  assert.equal(failed.status, 'Failed');
  assert.match(failed.error_message, /not a PDF, DOCX, XLSX/);
  assert.equal(result.metrics.failed_document_count, 1);

  assert.ok(result.requirements.length > 0, 'the readable document must still be extracted');
  assert.ok(result.warnings.some((warning) => warning.code === WARNING_CODES.DOCUMENT_FAILED));
});

test('a batch where every document fails raises an error', async () => {
  await assert.rejects(
    () =>
      extractDocuments([
        file('a.txt', Buffer.from('nope')),
        file('b.txt', Buffer.from('also nope')),
      ]),
    (error) => error instanceof AppError && error.code === 'EXTRACTION_FAILED'
  );
});

test('an empty upload is rejected', async () => {
  await assert.rejects(
    () => extractDocuments([]),
    (error) => error instanceof AppError && error.code === 'NO_DOCUMENTS'
  );
});

test('ambiguous wording is flagged rather than resolved', async () => {
  const result = await extractDocuments([file('PRD.docx', prdDocx())]);

  const creditor = result.requirements.find((requirement) =>
    /Creditor ID/.test(requirement.description)
  );
  assert.ok(creditor, 'the optional-field row should be extracted');
  assert.ok(creditor.ambiguities.length > 0, '"etc." should raise an ambiguity');
  assert.match(creditor.ambiguities[0], /open-ended/i);

  assert.ok(
    result.warnings.some((warning) => warning.code === WARNING_CODES.AMBIGUOUS_REQUIREMENT)
  );
});

/* ----------------------------------------------------------- conflicts -- */

test('a cross-document conflict preserves both sides and picks no winner', async () => {
  // The PRD says the timeout is 30 seconds; the RFC says 60.
  const result = await extractDocuments([file('PRD.docx', prdDocx()), file('RFC.pdf', rfcPdf())]);

  const conflicted = result.requirements.filter((requirement) => requirement.conflicts.length > 0);
  assert.ok(conflicted.length >= 2, 'both sides of the conflict must be marked');

  const conflict = conflicted[0].conflicts[0];
  assert.match(conflict.message, /CONFLICT DETECTED/);
  assert.match(conflict.message, /30/);
  assert.match(conflict.message, /60/);
  assert.equal(conflict.resolved, false);
  assert.equal(conflict.resolution_note, null, 'the tool must not resolve it');

  const documents = new Set(conflict.source_references.map((reference) => reference.document_id));
  assert.equal(documents.size, 2, 'both source documents must be cited');

  assert.ok(result.warnings.some((warning) => warning.code === WARNING_CODES.CONFLICTING_SOURCES));
});

test('a single document does not conflict with itself', async () => {
  const result = await extractDocuments([file('PRD.docx', prdDocx())]);
  assert.ok(result.requirements.every((requirement) => requirement.conflicts.length === 0));
});

/* ------------------------------------------------------ fallback dedup -- */

/**
 * The deterministic fallback used to drop any block whose text it had already
 * seen in the document. A PRD that writes one scenario per section repeats its
 * branch sentences word for word, so every scenario after the first lost them:
 * 29 branch sentences of the sanitized Routing PRD, including the INACTIVE
 * branch of MPM Cross Border Payment, never reached QA when Gemini #1 failed.
 * Identical text is now only merged inside one heading occurrence.
 */
const paragraph = (text, page, section) => ({
  kind: 'paragraph',
  text,
  level: null,
  page,
  section,
  sheet: null,
  cell: null,
  table: null,
});
const heading = (text, page) => ({ ...paragraph(text, page, text), kind: 'heading', level: 1 });
const fallbackOf = (blocks) => buildRequirements([{ documentId: 'DOC-001', blocks }]);

test('the same branch sentence under two scenarios is two requirements', async () => {
  const pdf = buildPdf([
    [
      'Domestic Payment',
      'IF INACTIVE, then reject the transaction with response code 92.',
      'IF ACTIVE, then send the transaction to the designated switching.',
    ],
    [
      'Cross Border Payment',
      'IF INACTIVE, then reject the transaction with response code 92.',
      'IF ACTIVE, then send the transaction to the designated switching.',
    ],
  ]);

  const result = await extractDocuments([file('Routing.pdf', pdf)]);
  assert.equal(result.structuring.mode, 'fallback');
  assert.deepEqual(
    result.requirements.map(({ description, source_references: [ref] }) => [
      ref.section,
      ref.page,
      description,
    ]),
    [
      ['Domestic Payment', 1, 'IF INACTIVE, then reject the transaction with response code 92.'],
      ['Domestic Payment', 1, 'IF ACTIVE, then send the transaction to the designated switching.'],
      [
        'Cross Border Payment',
        2,
        'IF INACTIVE, then reject the transaction with response code 92.',
      ],
      [
        'Cross Border Payment',
        2,
        'IF ACTIVE, then send the transaction to the designated switching.',
      ],
    ]
  );
  for (const requirement of result.requirements) {
    assert.ok(requirementSchema.safeParse(requirement).success, requirement.requirement_id);
  }
});

test('two scenarios under headings that read the same keep their own copies', () => {
  // The Routing PRD has two headings "Check the Switching of QRIS MPM Cross" on
  // p4, one per scenario, and the parser turns the actor label "SYS" into a
  // heading on several pages. Keyed by the heading's wording, the second
  // scenario's branch would still be merged into the first.
  const branch =
    'IF ACTIVE but the Switching is null , then use and send the transaction to DEFAULT_SWITCHING of that Bank';
  const { requirements, skipped } = fallbackOf([
    heading('SYS', 6),
    paragraph(branch, 6, 'SYS'),
    heading('SYS', 7),
    paragraph(branch, 7, 'SYS'),
  ]);

  assert.equal(skipped, 2, 'only the two headings are skipped');
  assert.deepEqual(
    requirements.map((requirement) => requirement.source_references[0].page),
    [6, 7]
  );
});

test('identical text inside one section is still one requirement', () => {
  // Existing behaviour, kept: a running header repeated on each page of one
  // section, or a line repeated within it, is the same statement. The match
  // stays case-insensitive.
  const header = 'Bank internal: this specification will be reviewed every quarter';
  const rule = 'Settlement batches must be confirmed by the host before release.';
  const { requirements, skipped } = fallbackOf([
    heading('Settlement Rules', 1),
    paragraph(header, 1, 'Settlement Rules'),
    paragraph(rule, 1, 'Settlement Rules'),
    paragraph(rule, 1, 'Settlement Rules'),
    paragraph(header, 2, 'Settlement Rules'),
    paragraph(header.toUpperCase(), 3, 'Settlement Rules'),
  ]);

  assert.deepEqual(
    requirements.map((requirement) => [
      requirement.description,
      requirement.source_references[0].page,
    ]),
    [
      [header, 1],
      [rule, 1],
    ]
  );
  assert.equal(skipped, 4, 'the heading and the three repeats');
});

test('text with no heading, section or sheet to place it is never merged', () => {
  // Nothing says the two are one statement, and a repeated requirement is
  // visible to QA where a merged one is not.
  const rule = 'The transaction must be rejected when the account is dormant.';
  const { requirements } = fallbackOf([paragraph(rule, 1, null), paragraph(rule, 2, null)]);

  assert.deepEqual(
    requirements.map((requirement) => requirement.source_references[0].page),
    [1, 2]
  );
});

test('identical spreadsheet rows merge within a sheet, not across sheets', () => {
  const row = (sheet, cell) => ({
    kind: 'table-row',
    text: 'Field: BIC Code | Rule: Mandatory, 8 or 11 characters',
    level: null,
    page: null,
    section: sheet,
    sheet,
    cell,
    table: { headers: ['Field', 'Rule'], cells: ['BIC Code', 'Mandatory, 8 or 11 characters'] },
  });
  const { requirements } = fallbackOf([
    row('Field Rules', 'A2:B2'),
    row('Field Rules', 'A3:B3'),
    row('Archive', 'A2:B2'),
  ]);

  assert.deepEqual(
    requirements.map((requirement) => requirement.source_references[0].section),
    ['Field Rules A2:B2', 'Archive A2:B2']
  );
});

test('the sanitized Routing PRD keeps every scenario branch on the fallback path', async () => {
  const pdf = readFileSync(
    new URL('../../fixtures/prd/PRD_Transaction_Routing_Sanitized.pdf', import.meta.url)
  );
  const { blocks } = await parsePdf(pdf, 'DOC-001');
  const { requirements } = fallbackOf(blocks);

  // Every IF branch that is a requirement at all is one once per occurrence.
  // (A fragment such as "IF ACTIVE, then :" is filtered as too short, which is
  // a different rule.)
  const emitted = new Set(requirements.map((requirement) => requirement.description));
  const branches = blocks.filter(
    (block) =>
      block.kind === 'paragraph' &&
      /^IF (?:ACTIVE|INACTIVE)\b/.test(block.text) &&
      emitted.has(block.text)
  );
  const count = (list, text) =>
    list.filter((item) => (item.text ?? item.description) === text).length;
  for (const branch of new Set(branches.map((block) => block.text))) {
    assert.equal(count(requirements, branch), count(branches, branch), branch);
  }
  // The repeats are the point: 23 on this parser, and the text dedup kept none.
  const repeats = branches.length - new Set(branches.map((block) => block.text)).size;
  assert.ok(repeats >= 23, `${repeats} repeated branch occurrences kept`);

  // The audit's example: MPM Cross Border Payment's INACTIVE branch (p5) reads
  // exactly like the p3 one and was the block the old dedup dropped.
  const inactive = requirements.filter((requirement) =>
    requirement.description.startsWith(
      'IF INACTIVE, then use and send the transaction to DEFAULT_SWITCHING of that Bank'
    )
  );
  assert.deepEqual(
    inactive.map((requirement) => requirement.source_references[0].page),
    [3, 5]
  );
});

/* ------------------------------------------------ PDF section attribution -- */

/**
 * A block's section is the last heading read before it, and the content stream
 * is not always reading order: the sanitized Routing PRD draws a page's numbered
 * headings before its table cells, so a cell continued at the top of page 5 was
 * filed under the heading printed at the bottom. A heading lying wholly below a
 * paragraph on the same page cannot be its section. These lock in what the
 * section becomes then, and that nothing else - order, text, other blocks -
 * changes.
 */
const at = (text, x, y) => ({ text, x, y });
const blocksOf = async (pdf) => (await parsePdf(pdf, 'DOC-001')).blocks;
const shape = (blocks) =>
  blocks.map((block) => [block.kind, block.page, block.section, block.text]);

test('a cell continued at the top of a page stays in the scenario it started in', async () => {
  const inactive = 'IF INACTIVE, then use the default switching of that bank.';
  const active = 'IF ACTIVE, then send the transaction to the switching.';
  const blocks = await blocksOf(
    buildPdf([
      [
        // Two scenarios under headings that read the same.
        at('Check the Switching', 50, 700),
        at(inactive, 50, 680),
        at(active, 50, 660),
        at('Check the Switching', 50, 400),
        at(active, 50, 380),
      ],
      [
        // The next section's heading is drawn first, then the second scenario's
        // INACTIVE branch at the top of the page, then the section's own text.
        at('2. Card Payments', 50, 500),
        at(inactive, 50, 760),
        at('Card payments must be authorised by the issuer.', 50, 480),
        at('A declined card payment must be reversed within one day.', 50, 460),
      ],
    ])
  );

  assert.deepEqual(shape(blocks), [
    ['heading', 1, 'Check the Switching', 'Check the Switching'],
    ['paragraph', 1, 'Check the Switching', inactive],
    ['paragraph', 1, 'Check the Switching', active],
    ['heading', 1, 'Check the Switching', 'Check the Switching'],
    ['paragraph', 1, 'Check the Switching', active],
    ['heading', 2, '2. Card Payments', '2. Card Payments'],
    // Stream order is kept; only the section is corrected.
    ['paragraph', 2, 'Check the Switching', inactive],
    ['paragraph', 2, '2. Card Payments', 'Card payments must be authorised by the issuer.'],
    [
      'paragraph',
      2,
      '2. Card Payments',
      'A declined card payment must be reversed within one day.',
    ],
  ]);

  // The fallback keeps both INACTIVE branches: one per heading occurrence.
  const { requirements } = fallbackOf(blocks);
  assert.deepEqual(
    requirements
      .filter((requirement) => requirement.description === inactive)
      .map(({ source_references: [ref] }) => [ref.page, ref.section]),
    [
      [1, 'Check the Switching'],
      [2, 'Check the Switching'],
    ]
  );
});

test('something new at the top of a page gets no section rather than the last one', async () => {
  // A scenario whose own heading the parser did not recognise starts at the
  // top of page 2, further left than the heading page 1 ended under. It is not
  // that heading's continuation, so it is not given that heading - and its
  // "THEN" lead-in must not merge with the identical one above it. (The section
  // heading spans both columns, as a real one does.)
  const lead = 'THEN the system must fulfill the following:';
  const section = '2. Card Payments and Refund Handling Rules';
  const blocks = await blocksOf(
    buildPdf([
      [
        at('Check the Switching', 150, 700),
        at(lead, 150, 680),
        at('IF ACTIVE, then send the transaction to the switching.', 150, 660),
      ],
      [
        at(section, 50, 400),
        at('Refund scenario: a customer returns the goods.', 50, 760),
        at(lead, 150, 740),
        at('Card payments must be authorised by the issuer.', 50, 380),
        at('A declined card payment must be reversed within one day.', 50, 360),
      ],
    ])
  );

  assert.deepEqual(shape(blocks).slice(3), [
    ['heading', 2, section, section],
    ['paragraph', 2, null, 'Refund scenario: a customer returns the goods.'],
    ['paragraph', 2, null, lead],
    ['paragraph', 2, section, 'Card payments must be authorised by the issuer.'],
    ['paragraph', 2, section, 'A declined card payment must be reversed within one day.'],
  ]);

  const { requirements } = fallbackOf(blocks);
  assert.deepEqual(
    requirements
      .filter((requirement) => requirement.description === lead)
      .map(({ source_references: [ref] }) => [ref.page, ref.section]),
    [
      [1, 'Check the Switching'],
      [2, null],
    ]
  );
});

test('text above the first heading of a document has no section rather than a wrong one', async () => {
  const blocks = await blocksOf(
    buildPdf([
      [
        at('1. Scope', 50, 500),
        at('This specification will be reviewed by the bank every quarter.', 50, 760),
        at('Transfers above the limit must be rejected.', 50, 480),
        at('A rejected transfer must be logged.', 50, 460),
      ],
    ])
  );

  assert.deepEqual(shape(blocks), [
    ['heading', 1, '1. Scope', '1. Scope'],
    ['paragraph', 1, null, 'This specification will be reviewed by the bank every quarter.'],
    ['paragraph', 1, '1. Scope', 'Transfers above the limit must be rejected.'],
    ['paragraph', 1, '1. Scope', 'A rejected transfer must be logged.'],
  ]);
});

test('cells of one row and text in another column keep the section they were read under', async () => {
  const blocks = await blocksOf(
    buildPdf([
      [
        at('Status Rules', 50, 600),
        // Same row: starts half a line above the heading-like cell beside it.
        at('A suspended account must be rejected.', 50, 610),
        // Another column: top of the page, but nowhere above the heading.
        at('The status must be refreshed every minute.', 330, 760),
        at('A dormant account must be reactivated first.', 50, 580),
        at('A closed account must never be reopened.', 50, 560),
      ],
    ])
  );

  assert.deepEqual(
    blocks.map((block) => [block.section, block.text]),
    [
      ['Status Rules', 'Status Rules'],
      ['Status Rules', 'A suspended account must be rejected.'],
      ['Status Rules', 'The status must be refreshed every minute.'],
      ['Status Rules', 'A dormant account must be reactivated first.'],
      ['Status Rules', 'A closed account must never be reopened.'],
    ]
  );
});

test('the Routing PRD files the Cross Border Payment INACTIVE branch under its own scenario', async () => {
  const blocks = await blocksOf(
    readFileSync(
      new URL('../../fixtures/prd/PRD_Transaction_Routing_Sanitized.pdf', import.meta.url)
    )
  );
  const branch = blocks.find(
    (block) =>
      block.page === 5 &&
      block.text.startsWith(
        'IF INACTIVE, then use and send the transaction to DEFAULT_SWITCHING of that Bank'
      )
  );

  // Not the section printed at the bottom of p5, but the switching check of
  // MPM Cross Border Payment that p4 ends under.
  assert.notEqual(branch.section, '3. QRIS TUNTAS (Transfer, Setor, Tarik) as Issuer');
  assert.equal(branch.section, 'Check the Switching of QRIS MPM Cross');

  // And the fallback still keeps it as its own requirement, with that section.
  const { requirements } = fallbackOf(blocks);
  assert.deepEqual(
    requirements
      .filter((requirement) =>
        requirement.description.startsWith(
          'IF INACTIVE, then use and send the transaction to DEFAULT_SWITCHING of that Bank'
        )
      )
      .map(({ source_references: [ref] }) => [ref.page, ref.section]),
    [
      // The p3 heading carries its actor since inline labels are read back in.
      [3, 'WHEN SYS check the Bank Code'],
      [5, 'Check the Switching of QRIS MPM Cross'],
    ]
  );
});

test('the Routing PRD switching matrix is not filed under Rollout Plan', async () => {
  const blocks = await blocksOf(
    readFileSync(
      new URL('../../fixtures/prd/PRD_Transaction_Routing_Sanitized.pdf', import.meta.url)
    )
  );
  const rows = blocks.filter(
    (block) => block.page === 8 && /\b(?:Issuer|Acquirer)\b/.test(block.text)
  );

  assert.equal(rows.length, 3, 'the matrix rows as the parser reads them');
  for (const row of rows) {
    // The rows start left of the only heading above them (the table header at
    // the foot of p7), so no section is named: unresolved, not Rollout Plan.
    assert.equal(row.section, null, row.text);
  }

  // Rollout Plan still heads what is printed under it.
  assert.equal(
    blocks.find((block) => block.text === 'Performance Test / Load Test (*If needed)').section,
    'Rollout Plan'
  );
});

test('the Settlement PRD Jira links stay with their table row', async () => {
  // A link cell starts slightly above its row's heading-like cell, in another
  // column. Neither is grounds for moving it.
  const blocks = await blocksOf(
    readFileSync(
      new URL('../../fixtures/prd/PRD_QR_Manager_Settlement_Report_SANITIZED.pdf', import.meta.url)
    )
  );
  const sectionOf = (text) => blocks.find((block) => block.text === text).section;

  assert.equal(sectionOf('QRM-17394: Settlement'), 'WHEN User opens the Settlement Report menu');
  assert.equal(
    sectionOf('QRM-17521: Check Status'),
    'WHEN the system executes the status verification'
  );
  assert.equal(sectionOf('QRM-19347: Add New'), 'WHEN User click Advance Search filter dropdown');
});

/* ---------------------------------------- PDF section across a page turn -- */

/**
 * Text at the top of a page inherits the heading the previous page ended on in
 * the stream. A table header row drawn after the rows below it is that heading
 * in the stream but not on the page, so a branch continued over the page turn
 * was filed under "Scenario Acceptance Criteria Jira Link". These lock in that
 * such a heading is not inherited, what is inherited instead, and that a
 * heading the stream reaches in reading order is inherited as before.
 */
const scenarioTable = (lastRows) =>
  buildPdf([
    [
      at('1. Card Refunds', 50, 790),
      at('WHEN a refund is asked', 150, 700),
      at('THEN the system must fulfill the following:', 150, 680),
      at('IF PAID, then refund the full amount to the card that paid for the order.', 160, 660),
      at('WHEN an order is cancelled', 150, 420),
      at('THEN the system must fulfill the following:', 150, 400),
      // The header row sits at the top of the table but is drawn last.
      at('Scenario Acceptance Criteria Jira Link', 50, 760),
    ],
    lastRows,
  ]);

test('a table header drawn last is not the section of the next page', async () => {
  const unpaid = 'IF UNPAID, then cancel the order without a refund.';
  const closed = 'THEN the order must be closed the same day.';
  const note = 'Disputed refunds are reported to finance every month.';
  const blocks = await blocksOf(
    scenarioTable([
      // Drawn first, but printed under the page's own heading further down: not
      // part of what continues from page 1, and not resolved here either.
      at(note, 150, 300),
      at(unpaid, 160, 760),
      at(closed, 150, 740),
      at('WHEN a refund is disputed', 150, 400),
    ])
  );

  // Stream order and text are kept; the continuation is filed under the
  // scenario page 1 ends in, not under the header row.
  assert.deepEqual(shape(blocks).slice(-5), [
    [
      'heading',
      1,
      'Scenario Acceptance Criteria Jira Link',
      'Scenario Acceptance Criteria Jira Link',
    ],
    ['paragraph', 2, null, note],
    ['paragraph', 2, 'WHEN an order is cancelled', unpaid],
    ['paragraph', 2, 'WHEN an order is cancelled', closed],
    ['heading', 2, 'WHEN a refund is disputed', 'WHEN a refund is disputed'],
  ]);
});

test('a table header drawn last is not inherited even when no row is read as a heading', async () => {
  // The rows here are prose, so the only other heading on page 1 is the
  // section the table sits in: that is what the next page continues.
  const blocks = await blocksOf(
    buildPdf([
      [
        at('1. Card Refunds', 50, 790),
        at('A refund is paid back to the card that paid for the order.', 150, 700),
        at('A cancelled order is closed without a refund.', 150, 420),
        at('Scenario Acceptance Criteria Jira Link', 50, 760),
      ],
      [at('A cancelled order must be closed the same day.', 150, 760)],
    ])
  );

  assert.deepEqual(shape(blocks).slice(-1), [
    ['paragraph', 2, '1. Card Refunds', 'A cancelled order must be closed the same day.'],
  ]);
});

test('a new scenario after a page turn starts its own section, or none if unrecognised', async () => {
  const unpaid = 'IF UNPAID, then cancel the order without a refund.';
  const lead = 'THEN the system must fulfill the following:';
  const blocks = await blocksOf(
    scenarioTable([
      at(unpaid, 160, 760),
      // A scenario row starting further left than the WHEN page 1 ended under:
      // something new, whose own heading the parser did not recognise...
      at('Chargeback scenario: the bank reverses a card payment.', 50, 720),
      // ...so its lead-in is not given the previous scenario either.
      at(lead, 150, 700),
      // A recognised heading starts a section as it always did.
      at('WHEN a payment is reversed', 150, 600),
      at('THEN the reversal must be logged.', 150, 580),
    ])
  );

  assert.deepEqual(
    blocks.filter((block) => block.page === 2).map((block) => [block.section, block.text]),
    [
      ['WHEN an order is cancelled', unpaid],
      [null, 'Chargeback scenario: the bank reverses a card payment.'],
      [null, lead],
      ['WHEN a payment is reversed', 'WHEN a payment is reversed'],
      ['WHEN a payment is reversed', 'THEN the reversal must be logged.'],
    ]
  );

  // The fallback keeps all three identical lead-ins: one per heading occurrence.
  const { requirements } = fallbackOf(blocks);
  assert.deepEqual(
    requirements
      .filter((requirement) => requirement.description === lead)
      .map(({ source_references: [ref] }) => [ref.page, ref.section]),
    [
      [1, 'WHEN a refund is asked'],
      [1, 'WHEN an order is cancelled'],
      [2, null],
    ]
  );
});

test('a heading reached in reading order is inherited over a page turn as before', async () => {
  const nextPage = [
    at('A partial refund must not exceed the amount paid.', 50, 760),
    at('The refund note is printed as an appendix.', 20, 740),
  ];
  const pageTwo = async (pageOne) =>
    (await blocksOf(buildPdf([pageOne, nextPage])))
      .filter((block) => block.page === 2)
      .map((block) => [block.section, block.text]);

  // Exactly what the parser produced before: the heading page 1 ends on is
  // inherited, even by text further left than it...
  const before = [
    ['Partial Refunds', 'A partial refund must not exceed the amount paid.'],
    ['Partial Refunds', 'The refund note is printed as an appendix.'],
  ];

  // ...when a running footer is drawn first, lower than everything, and the
  // heading ends the page...
  assert.deepEqual(
    await pageTwo([
      at('Card Refund Policy | Page 1', 50, 30),
      at('Refund Rules', 50, 760),
      at('A refund must be approved by a supervisor.', 50, 740),
      at('A refund is paid back to the card that paid.', 50, 720),
      at('A refund is confirmed to the customer by email.', 50, 700),
      at('Partial Refunds', 50, 200),
    ]),
    before
  );

  // ...and when a footnote is drawn before the heading but the heading still
  // heads text drawn after it.
  assert.deepEqual(
    await pageTwo([
      at('Refund Rules', 50, 760),
      at('A refund must be approved by a supervisor.', 50, 740),
      at('Footnote: card schemes may delay a refund by a day.', 50, 60),
      at('Partial Refunds', 50, 200),
      at('A partial refund must name the returned items.', 50, 180),
    ]),
    before
  );
});

test('the Routing PRD files the tops of pages 4 and 6 under the scenario they continue', async () => {
  const blocks = await blocksOf(
    readFileSync(
      new URL('../../fixtures/prd/PRD_Transaction_Routing_Sanitized.pdf', import.meta.url)
    )
  );
  const header = 'Scenario Acceptance Criteria Jira Link';

  // The table header is still read, but heads nothing on another page.
  assert.ok(blocks.some((block) => block.kind === 'heading' && block.text === header));
  assert.deepEqual(
    blocks.filter((block) => block.page !== 3 && block.page !== 5 && block.section === header),
    []
  );

  // p4 continues the Country Code check that p3 ends in.
  assert.equal(
    blocks.find(
      (block) => block.page === 4 && block.text === 'IF ACTIVE, then proceed to the next validation'
    ).section,
    'WHEN SYS identifies the Country Code'
  );

  // p6 continues Tuntas Transfer from the foot of p5 down to the next scenario,
  // whose name - read apart from its GIVEN since the cell border is honoured -
  // is the page's first heading.
  const firstHeading = blocks.findIndex((b) => b.page === 6 && b.kind === 'heading');
  const top = blocks.filter((block) => block.page === 6 && blocks.indexOf(block) < firstHeading);
  assert.equal(top.length, 11);
  for (const block of top) {
    assert.equal(block.section, 'WHEN SYS idenifies the Destination Bank Code', block.text);
  }
  assert.equal(blocks[firstHeading].text, 'Tuntas Setor');

  // Tuntas Setor's own WHEN still heads what follows it, and p7 still continues it.
  assert.equal(
    blocks.find(
      (block) =>
        block.page === 6 && block.text.startsWith('THEN') && blocks.indexOf(block) > firstHeading
    ).section,
    'WHEN SYS identifies the Issuer Bank Code'
  );
  assert.equal(
    blocks.find(
      (block) => block.page === 7 && block.text.startsWith('IF ACTIVE but the Switching is null')
    ).section,
    'WHEN SYS identifies the Issuer Bank Code'
  );

  // The fallback keeps both scenarios' branches as requirements of their own -
  // the same sentences, one set per scenario - each with its scenario.
  const { requirements } = fallbackOf(blocks);
  const onPage = (page) =>
    requirements
      .filter(({ source_references: [ref] }) => ref.page === page)
      .map(({ description, source_references: [ref] }) => [ref.section, description]);
  const transfer = 'WHEN SYS idenifies the Destination Bank Code';
  const setor = 'WHEN SYS identifies the Issuer Bank Code';
  assert.deepEqual(
    onPage(6).map(([section]) => section),
    [...Array(8).fill(transfer), ...Array(6).fill(setor)]
  );
  assert.deepEqual(
    onPage(6).filter(([, text]) => text === 'THEN the system must fulfill the following :'),
    [
      [transfer, 'THEN the system must fulfill the following :'],
      [setor, 'THEN the system must fulfill the following :'],
    ]
  );
  assert.deepEqual(onPage(4)[0], [
    'WHEN SYS identifies the Country Code',
    'IF ACTIVE, then proceed to the next validation',
  ]);
});

/* ---------------------------------------------------- PDF scenario tables -- */

/**
 * A scenario table puts the scenario's name in one cell and its GIVEN / WHEN /
 * THEN in the next. A one-line name and the GIVEN beside it arrive as one run on
 * one baseline, and were read as one line - "Tuntas Tarik GIVEN Mobile App user
 * initiates ..." - so the scenario was no heading and its GIVEN was filed under
 * the previous scenario. The drawn cell border between them is what separates
 * them; these lock in that it does, and only where a criterion starts.
 */
const border = (x, bottom, top) => ({ border: [x, bottom, top] });
const lead = 'THEN the system must fulfill the following:';
// The page's widest line, so that no scenario row reaches the margin.
const widest = at(
  'IF PAID, then refund the full amount to the card that paid for the order, within one working day of approval.',
  20,
  300
);

test('a scenario name and the GIVEN beside it are read as two cells', async () => {
  const given = 'GIVEN a paid order, the customer asks for a refund';
  const blocks = await blocksOf(
    buildPdf([
      [
        border(160, 280, 720),
        at('Card Refund', 50, 700),
        at(given, 165, 700),
        at('WHEN the refund is approved', 165, 680),
        at(lead, 165, 660),
        // A second scenario worded like the first, under a similar name.
        at('Card Refund Retry', 50, 600),
        at(given, 165, 600),
        at('WHEN the refund is approved', 165, 580),
        at(lead, 165, 560),
        widest,
      ],
    ])
  );

  assert.deepEqual(shape(blocks), [
    ['heading', 1, 'Card Refund', 'Card Refund'],
    ['paragraph', 1, 'Card Refund', given],
    ['heading', 1, 'WHEN the refund is approved', 'WHEN the refund is approved'],
    ['paragraph', 1, 'WHEN the refund is approved', lead],
    ['heading', 1, 'Card Refund Retry', 'Card Refund Retry'],
    ['paragraph', 1, 'Card Refund Retry', given],
    ['heading', 1, 'WHEN the refund is approved', 'WHEN the refund is approved'],
    ['paragraph', 1, 'WHEN the refund is approved', lead],
    ['paragraph', 1, 'WHEN the refund is approved', widest.text],
  ]);

  // Both scenarios keep their own lead-in: identical words, two scenarios.
  const { requirements } = fallbackOf(blocks);
  assert.equal(requirements.filter(({ description }) => description === lead).length, 2);
});

test('rows without both a drawn border and a criterion beside it are left as read', async () => {
  const given = 'GIVEN a paid order, the customer asks for a refund';
  const merged = `Card Refund ${given}`;
  const blocks = await blocksOf(
    buildPdf([
      [
        border(160, 740, 780),
        // A header row: three cells read as one line, as before.
        at('Scenario', 50, 760),
        at('Acceptance Criteria', 165, 760),
        // Criterion wording with no border between: one column of prose.
        at('Refund Rules', 50, 700),
        at('When a refund fails it is retried once.', 50, 680),
        at('Then the customer is told by email.', 50, 660),
        // A matrix row: a value cell, not a criterion.
        border(160, 590, 610),
        at('Card Refund', 50, 600),
        at('SWITCH_A', 165, 600),
        // No border drawn at this row's height.
        at('Card Refund', 50, 540),
        at(given, 165, 540),
        // A name running over the border: not two cells.
        border(160, 470, 490),
        at('Card Refund Request Form', 50, 480),
        at(given, 210, 480),
        // A wide filled box behind the row, and a thin clipping path: neither is
        // a cell border.
        { rect: [40, 410, 280, 430] },
        at('Card Refund', 50, 420),
        at(given, 165, 420),
        { rect: [159.5, 350, 160.5, 370], op: 'W n' },
        at('Card Refund', 50, 360),
        at(given, 165, 360),
        widest,
      ],
    ])
  );

  assert.deepEqual(
    blocks.map((block) => [block.kind, block.text]),
    [
      ['heading', 'Scenario Acceptance Criteria'],
      ['heading', 'Refund Rules'],
      ['paragraph', 'When a refund fails it is retried once.'],
      ['paragraph', 'Then the customer is told by email.'],
      ['paragraph', 'Card Refund SWITCH_A'],
      ['paragraph', merged],
      ['paragraph', `Card Refund Request Form ${given}`],
      ['paragraph', merged],
      ['paragraph', merged],
      ['paragraph', widest.text],
    ]
  );
});

test('a criterion written in lower case is split off too, and not joined back', async () => {
  const blocks = await blocksOf(
    buildPdf([
      [
        border(160, 280, 720),
        at('Card Refund', 50, 700),
        at('given a paid order, the customer asks for a refund', 165, 700),
        at('then the refund must be approved by a supervisor.', 165, 680),
        widest,
      ],
    ])
  );

  assert.deepEqual(shape(blocks).slice(0, 2), [
    ['heading', 1, 'Card Refund', 'Card Refund'],
    [
      'paragraph',
      1,
      'Card Refund',
      'given a paid order, the customer asks for a refund then the refund must be approved by a supervisor.',
    ],
  ]);
});

test('a criterion beside a scenario name that is not a heading gets no section', async () => {
  const given = 'GIVEN a paid order, the customer asks for part of it back';
  const blocks = await blocksOf(
    buildPdf([
      [
        border(160, 280, 720),
        at('Card Refund', 50, 700),
        at('GIVEN a paid order, the customer asks for a refund', 165, 700),
        at('THEN the refund must be approved by a supervisor.', 165, 680),
        // This scenario's name is not one the parser reads as a heading.
        at('Refund (partial),', 50, 600),
        at(given, 165, 600),
        at('THEN the reversal must be logged.', 165, 580),
        at('2. Reporting', 50, 520),
        at('Refunds are reported every month.', 50, 500),
        widest,
      ],
    ])
  );

  assert.deepEqual(
    blocks
      .filter((block) => block.kind === 'paragraph')
      .map((block) => [block.section, block.text]),
    [
      ['Card Refund', 'GIVEN a paid order, the customer asks for a refund'],
      ['Card Refund', 'THEN the refund must be approved by a supervisor.'],
      // Not "Card Refund": the row's own scenario is the unread one.
      ['Card Refund', 'Refund (partial),'],
      [null, given],
      [null, 'THEN the reversal must be logged.'],
      ['2. Reporting', 'Refunds are reported every month.'],
      ['2. Reporting', widest.text],
    ]
  );
});

test('a scenario split from its GIVEN carries over a page turn as before', async () => {
  const blocks = await blocksOf(
    buildPdf([
      [
        border(160, 60, 720),
        at('Card Refund', 50, 120),
        at('GIVEN a paid order, the customer asks for a refund', 165, 120),
        at('WHEN the refund is approved', 165, 100),
        at(lead, 165, 80),
        widest,
      ],
      [
        border(160, 700, 780),
        at('IF UNPAID, then cancel the order without a refund.', 175, 760),
        at('THEN the order must be closed the same day.', 165, 740),
      ],
    ])
  );

  assert.deepEqual(
    blocks.filter((block) => block.page === 2).map((block) => [block.section, block.text]),
    [
      ['WHEN the refund is approved', 'IF UNPAID, then cancel the order without a refund.'],
      ['WHEN the refund is approved', 'THEN the order must be closed the same day.'],
    ]
  );
});

test('the Routing PRD reads every scenario name apart from its acceptance criteria', async () => {
  const blocks = await blocksOf(
    readFileSync(
      new URL('../../fixtures/prd/PRD_Transaction_Routing_Sanitized.pdf', import.meta.url)
    )
  );
  const after = (name) => {
    const index = blocks.findIndex((block) => block.kind === 'heading' && block.text === name);
    assert.ok(index >= 0, name);
    return [
      blocks[index].page,
      blocks[index + 1].kind,
      blocks[index + 1].section,
      blocks[index + 1].text,
    ];
  };

  // The four names that shared a line with their GIVEN are headings of their
  // own, each followed by its GIVEN, as the multi-line names on p3-p4 were.
  assert.deepEqual(after('CPM Routing'), [
    5,
    'heading',
    'GIVEN SYS receives a CPM Payment Request as',
    'GIVEN SYS receives a CPM Payment Request as',
  ]);
  assert.deepEqual(after('Tuntas Transfer'), [
    5,
    'heading',
    'GIVEN Mobile App user initiates QRIS Transfer to',
    'GIVEN Mobile App user initiates QRIS Transfer to',
  ]);
  assert.deepEqual(after('Tuntas Setor'), [
    6,
    'paragraph',
    'Tuntas Setor',
    'GIVEN Other Bank Customer initiates QRIS Setor to Bank A Merchant Merchant App / EDC)',
  ]);
  assert.deepEqual(after('Tuntas Tarik'), [
    7,
    'paragraph',
    'Tuntas Tarik',
    'GIVEN Mobile App user initiates QRIS Tarik Tunai to Other Bank Merchant',
  ]);
  assert.deepEqual(
    blocks.filter((block) => /\S\s+GIVEN\b/.test(block.text)).map((block) => block.text),
    []
  );

  // The table header and the switching matrix are read as before.
  assert.equal(
    blocks.filter((block) => block.text === 'Scenario Acceptance Criteria Jira Link').length,
    3
  );
  assert.deepEqual(
    blocks.filter((block) => block.page === 8 && block.section === null).map((block) => block.text),
    [
      'MPM Domestic Issuer MPM Cross Border Issuer',
      'CPM Acquirer TUNTAS Transfer Issuer',
      'TUNTAS Setor Issuer TUNTAS Tarik Issuer',
    ]
  );

  // The fallback's requirements are unchanged: same text, order and sections.
  const { requirements } = fallbackOf(blocks);
  assert.equal(requirements.length, 53);
});

test('the clause after a split criterion starts its own block; a wrapped one rejoins', async () => {
  // The split GIVEN reaches as far as its whole line did, which is what lets a
  // wrapped GIVEN rejoin it - and what used to pull the next line, a WHEN, into
  // the GIVEN as well.
  const blocks = await blocksOf(
    buildPdf([
      [
        border(160, 590, 720),
        at('Card Refund', 50, 700),
        at('GIVEN a paid order is shown on the refund screen of the console', 165, 700),
        at('WHEN the customer asks for it', 165, 688),
        at('THEN the refund must be approved by a supervisor.', 165, 676),
        at('Card Refund Retry', 50, 640),
        at('GIVEN a paid order is refunded to the issuing bank of the', 165, 640),
        at('Bank A Merchant / EDC)', 165, 628),
        at('WHEN the bank confirms it', 165, 616),
        at('THEN the retry must be logged.', 165, 604),
      ],
    ])
  );

  assert.deepEqual(
    blocks.map((block) => [block.kind, block.text]),
    [
      ['heading', 'Card Refund'],
      ['heading', 'GIVEN a paid order is shown on the refund screen of the console'],
      ['heading', 'WHEN the customer asks for it'],
      ['paragraph', 'THEN the refund must be approved by a supervisor.'],
      ['heading', 'Card Refund Retry'],
      [
        'paragraph',
        'GIVEN a paid order is refunded to the issuing bank of the Bank A Merchant / EDC)',
      ],
      ['heading', 'WHEN the bank confirms it'],
      ['paragraph', 'THEN the retry must be logged.'],
    ]
  );
  assert.deepEqual(reconstructCriteria(blocks.slice(0, 4)), {
    given: ['a paid order is shown on the refund screen of the console'],
    when: ['the customer asks for it'],
    then: ['the refund must be approved by a supervisor.'],
  });
});

test('the Settlement PRD reads "Activate the Export Button" as name, GIVEN, WHEN and THEN', async () => {
  // The name shared a line with its GIVEN, so its "THEN the system must
  // fulfill:" sat in the previous scenario's heading occurrence and was merged
  // with that scenario's identical lead-in. Split from the name, the GIVEN then
  // took the WHEN below it in too: the click became part of the precondition.
  const blocks = await blocksOf(
    readFileSync(
      new URL('../../fixtures/prd/PRD_QR_Manager_Settlement_Report_SANITIZED.pdf', import.meta.url)
    )
  );
  const start = blocks.findIndex((block) => block.text === 'Activate the Export Button');
  const row = blocks.slice(start, start + 8);
  assert.deepEqual(
    row.slice(0, 4).map((block) => [block.kind, block.text]),
    [
      ['heading', 'Activate the Export Button'],
      ['heading', 'GIVEN QR Manager User is on the Settlement Report menu with data rendered'],
      ['heading', 'WHEN user moves the cursor over or clicks Export button'],
      ['paragraph', 'THEN the system must fulfill:'],
    ]
  );
  assert.deepEqual(reconstructCriteria(row), {
    given: ['QR Manager User is on the Settlement Report menu with data rendered'],
    when: ['user moves the cursor over or clicks Export button'],
    then: [
      'the system must fulfill:',
      'Maintain the Export to TXT button status as active and enabled under all data states',
      'Trigger the file generation or download process immediately upon clicking without any validation lockouts',
    ],
  });

  const { requirements } = fallbackOf(blocks);
  assert.deepEqual(
    requirements
      .filter(
        ({ description, source_references: [ref] }) =>
          ref.page === 4 && description === 'THEN the system must fulfill:'
      )
      .map(({ source_references: [ref] }) => ref.section),
    [
      'WHEN a transaction status has successfully achieved Settled or Released',
      'WHEN user moves the cursor over or clicks Export button',
      'WHEN QR Manager User opens the Settlement Report menu',
    ]
  );
});

/* ------------------------------------------------------ PDF inline labels -- */

/**
 * Confluence draws an inline mention or status label ("Mobile App", "SYS") in a
 * smaller font after everything else on the page. Read in stream order it was a
 * line of its own - a heading - and the sentence it belonged to lost its actor.
 * It goes back into the line whose baseline it shares when it fills that
 * line's own empty space; layout decides, not the label's wording.
 */
const label = (text, x, y) => ({ text, x, y, size: 8 });

test('an actor label drawn after its sentence is read back into it, not as a heading', async () => {
  const blocks = await blocksOf(
    buildPdf([
      [
        at('Payment Rules', 50, 760),
        // The sentences leave a gap where the label is drawn.
        at('GIVEN', 50, 700),
        at('sending a payment request to the switch', 140, 700),
        at('WHEN', 50, 640),
        at('checks the bank code of the request', 140, 640),
        // Drawn last, half a point below the baseline, in a smaller font.
        label('Mobile App', 92, 699.3),
        label('SYS', 92, 639.3),
      ],
      ['THEN the request must be routed to the switch of that bank.'],
    ])
  );

  // (The two unpunctuated lines join into one paragraph, as they always did.)
  assert.deepEqual(shape(blocks), [
    ['heading', 1, 'Payment Rules', 'Payment Rules'],
    [
      'paragraph',
      1,
      'Payment Rules',
      'GIVEN Mobile App sending a payment request to the switch WHEN SYS checks the bank code of the request',
    ],
    // The next page continues under the real heading, not under "SYS".
    [
      'paragraph',
      2,
      'Payment Rules',
      'THEN the request must be routed to the switch of that bank.',
    ],
  ]);
});

test('a label right after a line or wrapped to its start is read back too', async () => {
  const blocks = await blocksOf(
    buildPdf([
      [
        at('Transfer Rules', 50, 760),
        // "...request to" ends at x=272.1; the label starts a space later.
        at('GIVEN the customer sends the request to', 50, 700),
        at('THEN the transfer must be confirmed.', 50, 660),
        at('GIVEN the customer sends the request to', 50, 620),
        // The second line of this one starts with a label at the line start.
        at('Merchant / EDC)', 130, 600),
        at('THEN the deposit must be confirmed.', 50, 560),
        label('SYS', 275, 699.3),
        label('Bank A', 50, 599.3),
      ],
    ])
  );

  assert.deepEqual(
    blocks.map((block) => [block.kind, block.text]),
    [
      ['heading', 'Transfer Rules'],
      [
        'paragraph',
        'GIVEN the customer sends the request to SYS THEN the transfer must be confirmed.',
      ],
      ['paragraph', 'GIVEN the customer sends the request to Bank A Merchant / EDC)'],
      ['paragraph', 'THEN the deposit must be confirmed.'],
    ]
  );
});

test('genuine headings and small text elsewhere are left alone', async () => {
  const blocks = await blocksOf(
    buildPdf([
      [
        // A heading that happens to read like an actor label.
        at('Mobile App', 50, 760),
        at('The app must show the switch status of every bank.', 50, 740),
        at('The switch status is shown.', 50, 700),
        at('GIVEN', 50, 660),
        at('the operator opens the console.', 140, 660),
        // All drawn last, like real labels, and none of them fits a line:
        // small text in another column, far from the line it shares a baseline with...
        label('SYS', 400, 699.3),
        // ...text of the body's own size in a gap...
        at('Console', 92, 659.3),
        // ...and small text on no line's baseline.
        label('Note', 50, 600),
      ],
    ])
  );

  // Exactly what the parser produced before inline labels were read back.
  assert.deepEqual(
    blocks.map((block) => [block.kind, block.section, block.text]),
    [
      ['heading', 'Mobile App', 'Mobile App'],
      ['paragraph', 'Mobile App', 'The app must show the switch status of every bank.'],
      ['paragraph', 'Mobile App', 'The switch status is shown.'],
      ['paragraph', 'Mobile App', 'GIVEN the operator opens the console.'],
      ['heading', 'SYS', 'SYS'],
      ['heading', 'Console', 'Console'],
      ['heading', 'Note', 'Note'],
    ]
  );
});

test('the Routing PRD reads its actor labels back into the scenarios on pages 6 and 7', async () => {
  const blocks = await blocksOf(
    readFileSync(
      new URL('../../fixtures/prd/PRD_Transaction_Routing_Sanitized.pdf', import.meta.url)
    )
  );
  const textOf = (page, start) =>
    blocks.find((block) => block.page === page && block.text.startsWith(start))?.text;

  // No inline label survives as a heading of its own anywhere in the document.
  const labels = ['SYS', 'Mobile App', 'Merchant App', 'Bank A Merchant App', 'Routing Console'];
  assert.deepEqual(
    blocks.filter((block) => block.kind === 'heading' && labels.includes(block.text)),
    []
  );

  // (The scenario names beside these GIVENs are blocks of their own.)
  assert.equal(
    textOf(6, 'GIVEN'),
    'GIVEN Other Bank Customer initiates QRIS Setor to Bank A Merchant Merchant App / EDC)'
  );
  assert.equal(textOf(6, 'WHEN'), 'WHEN SYS identifies the Issuer Bank Code');
  assert.equal(
    textOf(7, 'GIVEN'),
    'GIVEN Mobile App user initiates QRIS Tarik Tunai to Other Bank Merchant'
  );
  assert.equal(textOf(7, 'WHEN'), 'WHEN SYS identifies the Acquirer Bank Code');

  // The top of p7 continues Tuntas Setor from p6, and is filed there rather than
  // under the "SYS" label that used to end p6.
  assert.equal(
    blocks.find(
      (block) => block.page === 7 && block.text.startsWith('IF ACTIVE but the Switching is null')
    ).section,
    'WHEN SYS identifies the Issuer Bank Code'
  );

  // The p3 table header no longer has the labels of the row below glued to it.
  assert.ok(blocks.some((block) => block.text === 'Scenario Acceptance Criteria Jira Link'));
  assert.ok(!blocks.some((block) => block.text.includes('Jira Link Mobile App')));
});

/* --------------------------------------------------------------- shape -- */

test('requirement ids are sequential and deterministic across a batch', async () => {
  const files = [file('PRD.docx', prdDocx()), file('RFC.pdf', rfcPdf())];

  const first = await extractDocuments(files);
  const second = await extractDocuments(files);

  const ids = first.requirements.map((requirement) => requirement.requirement_id);
  assert.deepEqual(
    ids,
    ids.map((unused, index) => `REQ-${String(index + 1).padStart(3, '0')}`)
  );

  assert.deepEqual(
    ids,
    second.requirements.map((requirement) => requirement.requirement_id),
    'the same input must always produce the same ids'
  );
  assert.deepEqual(
    first.requirements.map((requirement) => requirement.description),
    second.requirements.map((requirement) => requirement.description)
  );
});

test('every extracted requirement and document satisfies the canonical schema', async () => {
  const result = await extractDocuments([
    file('PRD.docx', prdDocx()),
    file('RFC.pdf', rfcPdf()),
    file('Matrix.xlsx', matrixXlsx()),
  ]);

  for (const document of result.documents) {
    const parsed = documentSchema.safeParse(document);
    assert.ok(
      parsed.success,
      `document ${document.document_id}: ${JSON.stringify(parsed.error?.issues)}`
    );
  }

  for (const requirement of result.requirements) {
    const parsed = requirementSchema.safeParse(requirement);
    assert.ok(
      parsed.success,
      `${requirement.requirement_id}: ${JSON.stringify(parsed.error?.issues)}`
    );
  }
});

test('every category is one of the nine permitted values', async () => {
  const result = await extractDocuments([
    file('PRD.docx', prdDocx()),
    file('RFC.pdf', rfcPdf()),
    file('Matrix.xlsx', matrixXlsx()),
  ]);

  for (const requirement of result.requirements) {
    assert.ok(
      REQUIREMENT_CATEGORIES.includes(requirement.category),
      `${requirement.requirement_id} has category '${requirement.category}'`
    );
  }
});

test('categorisation follows the documented precedence', async () => {
  const result = await extractDocuments([
    file('PRD.docx', prdDocx()),
    file('Matrix.xlsx', matrixXlsx()),
  ]);

  const byText = (pattern) =>
    result.requirements.find((requirement) => pattern.test(requirement.description));

  // No validation vocabulary, so rejection wins.
  assert.equal(byText(/Suspended participant must be rejected/).category, 'Error Handling');

  // A validation rule that names its error code stays a validation rule.
  assert.equal(byText(/BIC Code.*Mandatory/s).category, 'Input Validation');

  // A numeric limit is a constraint, even though it mentions status.
  assert.equal(byText(/timeout for participant status/).category, 'Constraint');
});

test('Indonesian requirement wording is recognised', async () => {
  const indonesian = buildDocx([
    { heading: 'Ketentuan', level: 1 },
    { text: 'Pengguna C-Ops tidak boleh mengubah kolom pada menu Overdraft Account.' },
    { text: 'Transaksi harus ditolak apabila nomor rekening tidak valid.' },
    { text: 'Jumlah maksimal transaksi dalam satu batch adalah 50 transaksi.' },
  ]);

  const result = await extractDocuments([file('PRD Indonesia.docx', indonesian)]);
  assert.equal(result.requirements.length, 3, 'all three Indonesian statements should be found');
  assert.equal(
    result.requirements.find((requirement) => /ditolak/.test(requirement.description)).category,
    'Error Handling'
  );
});

test('extraction writes nothing to disk', async () => {
  // Belt and braces alongside the static guard in no-persistence.test.js: run a
  // real extraction and confirm the working tree is untouched.
  const { readdirSync } = await import('node:fs');
  const before = readdirSync(process.cwd()).sort();

  await extractDocuments([file('PRD.docx', prdDocx()), file('RFC.pdf', rfcPdf())]);

  assert.deepEqual(readdirSync(process.cwd()).sort(), before);
});
