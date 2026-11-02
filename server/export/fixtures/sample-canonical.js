import { preMarkedEdgeCase, sampleTestCases } from './sample-test-cases.js';

/**
 * A complete canonical project: documents, requirements and test cases that
 * reference each other properly.
 *
 * Scaffolding. Milestones 2 and 4 produce this data from real documents and the
 * LLM; until they exist, this is what lets the review, validation and export
 * stages be built and exercised end to end. Delete it once /api/extract and
 * /api/generate are real.
 *
 * REQ-004 is deliberately left uncovered so the coverage report in the
 * validation stage has something true to say (PRD 16).
 */
const documents = [
  {
    document_id: 'DOC-001',
    filename: 'PRD Bulk Credit Transfer Phase 2.docx',
    document_type: 'PRD',
    mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size_bytes: 148_204,
    page_count: null, // DOCX has no fixed pagination - section carries traceability
    extracted_char_count: 4837,
    status: 'Extracted',
    error_message: null,
  },
  {
    document_id: 'DOC-002',
    filename: 'RFC Bulk Credit Transfer Limits.pdf',
    document_type: 'RFC',
    mime_type: 'application/pdf',
    size_bytes: 982_311,
    page_count: 12,
    extracted_char_count: 9120,
    status: 'Extracted',
    error_message: null,
  },
];

const requirements = [
  {
    requirement_id: 'REQ-001',
    title: 'Bulk Credit Transfer to a different bank',
    description:
      'A Bulk Credit Transfer submitted to a participating receiving bank must complete and be recorded in the BI-FAST Portal and the related report.',
    category: 'Functional Behavior',
    source_references: [{ document_id: 'DOC-001', page: null, section: 'Objective', quote: null }],
    ambiguities: [],
    conflicts: [],
  },
  {
    requirement_id: 'REQ-002',
    title: 'Mandatory field validation',
    description:
      'A transfer missing a mandatory field such as BIC code, account number or End to End Message ID must be rejected with reason code ADMI 002.',
    category: 'Input Validation',
    source_references: [
      { document_id: 'DOC-001', page: null, section: 'Business Rules', quote: null },
    ],
    ambiguities: [],
    conflicts: [],
  },
  {
    requirement_id: 'REQ-003',
    title: 'Batch size limits',
    description:
      'A batch of up to 50 transactions is accepted. A batch exceeding 1000 transactions is rejected and no transactions are posted.',
    category: 'Constraint',
    source_references: [
      { document_id: 'DOC-002', page: 4, section: '3.2 Transfer Limits', quote: null },
      { document_id: 'DOC-001', page: null, section: 'Business Rules', quote: null },
    ],
    // A genuine ambiguity, so the requirement review screen has one to show.
    ambiguities: ['Behaviour between 51 and 1000 transactions is not stated in either document.'],
    conflicts: [],
  },
  {
    requirement_id: 'REQ-004',
    title: 'Participant status routing',
    description:
      'Transactions originating from a Suspended participant must be rejected with reason code U253.',
    category: 'Business Rule',
    source_references: [
      { document_id: 'DOC-002', page: 7, section: '4.1 Participant Status', quote: null },
    ],
    ambiguities: [],
    conflicts: [
      {
        message:
          'PRD states a 30 second timeout for status lookup; RFC states 60 seconds. Human resolution required.',
        source_references: [
          { document_id: 'DOC-001', page: null, section: 'Business Rules', quote: null },
          { document_id: 'DOC-002', page: 9, section: '4.4 Timeouts', quote: null },
        ],
        resolved: false,
        resolution_note: null,
      },
    ],
  },
];

/** Spread the fixture test cases across requirements so coverage is meaningful. */
const REQUIREMENT_MAP = {
  'TC-001': ['REQ-001'],
  'TC-002': ['REQ-002'],
  'TC-003': ['REQ-003'],
  'TC-004': ['REQ-003'],
  'TC-005': ['REQ-002'],
  'TC-006': ['REQ-003'],
};

export function buildSampleCanonical() {
  const testCases = [...sampleTestCases, preMarkedEdgeCase].map((testCase, index) => ({
    ...testCase,
    requirement_ids: REQUIREMENT_MAP[testCase.case_id] ?? [],
    order_index: index,
  }));

  return {
    project: {
      project_name: 'Bulk Credit Transfer Phase 2',

      // The five generated outputs, written the way milestone 4 should produce
      // them: concise, specific, and derived from the requirements above.
      project_description:
        'Enables bulk credit transfer submission to participating BI-FAST banks with batch size and participant status controls.',

      project_summary:
        'Phase 2 extends the existing Bulk Credit Transfer service so a single submission can route to participating receiving banks, with mandatory field validation, batch size ceilings and participant status checks applied before any transaction is posted.',

      qa_guidance:
        'Focus on rejection paths rather than the happy path: mandatory field validation, the batch size boundaries at 50 and 1000 transactions, and routing behaviour when the originating participant is Suspended. Confirm that rejected batches post no transactions at all, and that every outcome is recorded in both the BI-FAST Portal and the related report.',

      project_background:
        'Bulk Credit Transfer currently supports submission within a single receiving bank. Phase 2 extends it across participating BI-FAST banks, which introduces new rejection conditions around mandatory fields, batch size limits and participant status. SIT covers those routing and validation paths, and the reporting that records their outcomes; it does not cover the underlying BI-FAST connector, which is unchanged.',

      sit_scope: [
        'Bulk Credit Transfer Routing: Validating successful submission to participating receiving banks and the resulting BI-FAST Portal records.',
        'Mandatory Field Validation: Confirming rejection with reason code ADMI 002 when required fields are absent.',
        'Batch Size Limits: Verifying acceptance at 50 transactions and rejection above 1000, with no partial posting.',
        'Participant Status Routing: Validating transaction behavior based on Active vs. Suspended participant bank statuses.',
      ],
    },
    documents,
    requirements,
    test_cases: testCases,
  };
}
