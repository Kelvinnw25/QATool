import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { AppError } from '../lib/errors.js';
import { exportFilename, exportSitScript } from './sit-script-export.js';
import { inspectWorkbook } from './inspect.js';
import { assertTemplateStyles, loadTemplate } from './template.js';
import {
  preMarkedEdgeCase,
  sampleTestCases,
  unresolvedEdgeCase,
} from './fixtures/sample-test-cases.js';

const TEMPLATE = config.templatePath;

function exportFixtures(testCases = sampleTestCases) {
  return exportSitScript(testCases, { templatePath: TEMPLATE });
}

test('the template ships with the sample rows this export must clear', () => {
  const template = inspectWorkbook(fs.readFileSync(TEMPLATE));
  assert.equal(template.dataRows.length, 19, 'template carries 19 BI-FAST sample rows');
  assert.equal(template.dataRows[0].cells.H, 'PASSED');
  assert.equal(template.dataRows[0].cells.I, 'Kelvin');
});

test('the style indices the writer relies on are still valid', () => {
  const { parts } = loadTemplate(TEMPLATE);
  const result = assertTemplateStyles(parts);
  assert.ok(result.ok, result.reason);
});

test('the template file is not modified by an export', () => {
  const before = createHash('sha256').update(fs.readFileSync(TEMPLATE)).digest('hex');
  exportFixtures();
  const after = createHash('sha256').update(fs.readFileSync(TEMPLATE)).digest('hex');
  assert.equal(after, before, 'the office template must be read-only');
});

test('the sample rows are cleared and replaced', () => {
  const workbook = inspectWorkbook(exportFixtures().buffer);

  assert.equal(workbook.dataRows.length, sampleTestCases.length);
  assert.equal(workbook.dataRows[0].cells.A, 'TC-001');
  assert.ok(
    !workbook.dataRows.some((row) => row.cells.C?.includes('Successful Bulk Credit Transfer to')),
    'no BI-FAST sample text should survive'
  );
});

test('the header is reproduced verbatim, typo and all', () => {
  const workbook = inspectWorkbook(exportFixtures().buffer);
  assert.deepEqual(workbook.headerRow, {
    A: 'Case ID',
    B: 'Section',
    C: 'Test Case',
    D: 'Case Type',
    E: 'Priority',
    F: 'Type',
    // The office template really does spell it this way. Correcting it here
    // would make the export disagree with the artefact QA circulates.
    G: 'Exected Result',
    H: 'Status',
    I: 'Tested By',
  });
});

test('Edge cases are downgraded and marked in the workbook', () => {
  const workbook = inspectWorkbook(exportFixtures().buffer);
  const byCaseId = Object.fromEntries(workbook.dataRows.map((row) => [row.cells.A, row.cells]));

  // TC-003 is Edge / valid boundary.
  assert.equal(byCaseId['TC-003'].D, 'Positive');
  assert.ok(byCaseId['TC-003'].G.startsWith('[Edge Case] '));

  // TC-004 is Edge / invalid boundary.
  assert.equal(byCaseId['TC-004'].D, 'Negative');
  assert.ok(byCaseId['TC-004'].G.startsWith('[Edge Case] '));

  // Plain rows are untouched.
  assert.equal(byCaseId['TC-001'].D, 'Positive');
  assert.ok(!byCaseId['TC-001'].G.includes('[Edge Case]'));
  assert.equal(byCaseId['TC-002'].D, 'Negative');
  assert.ok(!byCaseId['TC-002'].G.includes('[Edge Case]'));
});

test('no exported Case Type falls outside the template dropdown', () => {
  const workbook = inspectWorkbook(exportFixtures([...sampleTestCases, preMarkedEdgeCase]).buffer);
  for (const row of workbook.dataRows) {
    assert.ok(
      ['Positive', 'Negative'].includes(row.cells.D),
      `row ${row.row} has Case Type '${row.cells.D}', which the dropdown rejects`
    );
  }
});

test('execution fields are exported blank', () => {
  const workbook = inspectWorkbook(exportFixtures().buffer);
  for (const row of workbook.dataRows) {
    assert.equal(row.cells.H, '', `row ${row.row} Status must be blank`);
    assert.equal(row.cells.I, '', `row ${row.row} Tested By must be blank`);
  }
});

test('multi-line and XML-hostile text survives intact', () => {
  const workbook = inspectWorkbook(exportFixtures().buffer);
  const rows = Object.fromEntries(workbook.dataRows.map((row) => [row.cells.A, row.cells]));

  assert.ok(rows['TC-001'].G.includes('\n'), 'newlines must be preserved');
  assert.equal(rows['TC-001'].G.split('\n').length, 3);

  const escaped = rows['TC-005'].G;
  assert.ok(escaped.includes('&'), 'ampersand must round-trip');
  assert.ok(escaped.includes('"Suspended"'), 'quotes must round-trip');
  assert.ok(escaped.includes('< limit'), 'angle bracket must round-trip');
});

test('dropdown formulas are preserved verbatim', () => {
  const workbook = inspectWorkbook(exportFixtures().buffer);
  const formulas = workbook.validations.map((validation) => validation.formula1);

  assert.ok(formulas.includes('"Positive,Negative"'));
  assert.ok(formulas.includes('"High,Medium,Low,Critical"'));
  assert.ok(formulas.includes('"PASSED,FAILED,NOT TESTED,Take Out,BLOCKED"'));
  assert.ok(formulas.includes('"Kelvin"'));
});

test('validation and table ranges follow an arbitrary test case count', () => {
  for (const count of [1, 3, 5, 19, 20, 47, 120]) {
    const testCases = Array.from({ length: count }, (unused, index) => ({
      ...sampleTestCases[index % sampleTestCases.length],
      case_id: `TC-${String(index + 1).padStart(3, '0')}`,
      order_index: index,
    }));

    const result = exportFixtures(testCases);
    const workbook = inspectWorkbook(result.buffer);
    const lastRow = count + 1;

    assert.equal(workbook.dataRows.length, count, `${count} cases -> ${count} rows`);
    assert.equal(result.lastRow, lastRow);

    for (const validation of workbook.validations) {
      assert.match(
        validation.sqref,
        new RegExp(`^[A-Z]+2:[A-Z]+${lastRow}$`),
        `${count} cases: validation '${validation.sqref}' should end at row ${lastRow}`
      );
    }

    assert.equal(workbook.tableRef, `C2:C${lastRow}`, `${count} cases: table range`);
  }
});

test('an empty export still produces a structurally valid workbook', () => {
  const result = exportFixtures([]);
  const workbook = inspectWorkbook(result.buffer);

  assert.equal(workbook.dataRows.length, 0);
  assert.equal(result.lastRow, 2, 'ranges collapse onto row 2 rather than inverting');
  for (const validation of workbook.validations) {
    assert.match(validation.sqref, /^[A-Z]+2:[A-Z]+2$/);
  }
});

test('every non-regenerated part is copied through byte-for-byte', () => {
  const template = loadTemplate(TEMPLATE);
  const workbook = inspectWorkbook(exportFixtures().buffer);

  assert.deepEqual(
    workbook.partNames,
    Object.keys(template.parts).sort(),
    'no part may be added or dropped'
  );
  assert.ok(workbook.hasDrawing, 'the drawing reference must survive');
});

/**
 * The draft reaches the reviewer. An Edge case whose polarity is still open is
 * written as 'Edge' - the value it actually has - rather than being guessed
 * into Positive or Negative, or costing the whole workbook. The export says
 * which row to look at.
 */
test('an unresolved Edge case exports as Edge, with a warning, instead of blocking', () => {
  const result = exportFixtures([...sampleTestCases, unresolvedEdgeCase]);

  assert.equal(result.rowCount, sampleTestCases.length + 1, 'no row was dropped');

  const workbook = inspectWorkbook(result.buffer);
  const row = workbook.dataRows.find((entry) => entry.cells.A === unresolvedEdgeCase.case_id);

  assert.ok(row, 'the case is in the workbook');
  assert.equal(row.cells.D, 'Edge', 'neither guessed nor coerced');
  assert.match(row.cells.G, /^\[Edge Case\] /, 'and still marked as an Edge row');

  const warning = result.warnings.find((entry) => entry.case_id === unresolvedEdgeCase.case_id);
  assert.equal(warning.code, 'EDGE_POLARITY_UNRESOLVED_EXPORTED');
  assert.match(warning.message, /QA review required/);
});

test('a clean export carries no warnings', () => {
  assert.deepEqual(exportFixtures().warnings, []);
});

/** Structural failures still block, and still all at once. */
test('all blocking issues are reported at once', () => {
  const broken = [
    { ...sampleTestCases[0], case_id: 'TC-101', expected_result: '' },
    { ...sampleTestCases[1], case_id: 'TC-102', test_case: '   ' },
  ];

  assert.throws(
    () => exportFixtures(broken),
    (error) => {
      assert.equal(error.code, 'EXPORT_BLOCKED');
      assert.equal(error.details.length, 2);
      assert.deepEqual(error.details.map((issue) => issue.case_id).sort(), ['TC-101', 'TC-102']);
      return true;
    }
  );
});

/**
 * The mixed batch: clean rows, a resolved Edge case, and three drafts carrying
 * values the dropdowns do not offer. Everything reaches the workbook, nothing
 * is altered, and every questionable cell is named.
 */
test('a mixed batch exports whole, preserving every drafted value', () => {
  const cases = [
    ...sampleTestCases,
    unresolvedEdgeCase,
    { ...sampleTestCases[0], case_id: 'TC-201', case_type: 'Positiv', edge_polarity: null },
    { ...sampleTestCases[0], case_id: 'TC-202', priority: 'Urgent' },
    { ...sampleTestCases[0], case_id: 'TC-203', case_type: 'Edge', edge_polarity: 'borderline' },
  ];

  const result = exportFixtures(cases);
  assert.equal(result.rowCount, cases.length, 'no case was silently removed');

  const byId = new Map(inspectWorkbook(result.buffer).dataRows.map((r) => [r.cells.A, r.cells]));
  assert.equal(byId.get('TC-201').D, 'Positiv', 'not corrected to Positive');
  assert.equal(byId.get('TC-202').E, 'Urgent', 'not mapped onto High');
  assert.equal(byId.get('TC-203').D, 'Edge', 'not guessed into Positive or Negative');

  assert.deepEqual(
    result.warnings.map((warning) => warning.case_id).sort(),
    ['TC-007', 'TC-201', 'TC-202', 'TC-203'],
    'each questionable case is named once'
  );
});

test('a missing template produces a controlled error, not a stack trace', () => {
  assert.throws(
    () => exportSitScript(sampleTestCases, { templatePath: 'templates/does-not-exist.xlsx' }),
    (error) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'EXPORT_GENERATION_FAILED');
      return true;
    }
  );
});

test('rows follow order_index, not array order', () => {
  const shuffled = [
    { ...sampleTestCases[2], order_index: 0 },
    { ...sampleTestCases[0], order_index: 1 },
    { ...sampleTestCases[1], order_index: 2 },
  ];
  const workbook = inspectWorkbook(exportFixtures(shuffled).buffer);
  assert.deepEqual(
    workbook.dataRows.map((row) => row.cells.A),
    ['TC-003', 'TC-001', 'TC-002']
  );
});

test('the same input produces byte-identical output', () => {
  const first = exportFixtures().buffer;
  const second = exportFixtures().buffer;
  assert.equal(
    createHash('sha256').update(first).digest('hex'),
    createHash('sha256').update(second).digest('hex'),
    'export must be deterministic'
  );
});

test('filenames are safe on Windows', () => {
  assert.equal(exportFilename('Bulk Credit Transfer'), 'SIT Script - Bulk Credit Transfer.xlsx');
  assert.equal(exportFilename('A/B: "C" <D>'), 'SIT Script - AB C D.xlsx');
  assert.equal(exportFilename(''), 'SIT Script - Project.xlsx');
  assert.equal(exportFilename(null), 'SIT Script - Project.xlsx');
});
