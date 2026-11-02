/**
 * A canonical project as it stands after extraction and before generation.
 *
 * Synthetic, and shaped like the real thing: Indonesian requirement text with
 * English technical terms, a DOCX source with no page number, a PDF source with
 * one, an ambiguity and an unresolved cross-document conflict. The conflict and
 * the ambiguity are there so tests can check that generation reports them
 * rather than quietly resolving them.
 */
export function sampleCanonicalInput() {
  return {
    project: { project_name: 'BI-FAST Overdraft', sit_scope: [] },
    documents: [
      {
        document_id: 'DOC-001',
        filename: 'PRD Overdraft.docx',
        document_type: 'PRD',
        status: 'Extracted',
        page_count: null,
        extracted_char_count: 4210,
      },
      {
        document_id: 'DOC-002',
        filename: 'RFC Limits.pdf',
        document_type: 'RFC',
        status: 'Extracted',
        page_count: 3,
        extracted_char_count: 1880,
      },
    ],
    requirements: [
      {
        requirement_id: 'REQ-001',
        title: 'BIC Code wajib diisi',
        description:
          'Field BIC Code wajib diisi dan harus terdiri dari 8 atau 11 karakter. Jika kosong, transaksi ditolak dengan error ADMI 002.',
        category: 'Input Validation',
        source_references: [
          {
            document_id: 'DOC-001',
            page: null,
            section: 'Ketentuan > Validasi',
            quote: 'Field: BIC Code | Rule: Mandatory, 8 or 11 chars | Error: ADMI 002',
          },
        ],
        ambiguities: [],
        conflicts: [],
      },
      {
        requirement_id: 'REQ-002',
        title: 'Peserta Suspended ditolak',
        description:
          'Transaksi ke bank peserta dengan status Suspended harus ditolak dan tidak diteruskan ke BI-FAST.',
        category: 'Business Rule',
        source_references: [
          {
            document_id: 'DOC-001',
            page: null,
            section: 'Ketentuan > Business Rules',
            quote: 'Peserta dengan status Suspended: transaksi ditolak.',
          },
        ],
        ambiguities: [],
        conflicts: [],
      },
      {
        requirement_id: 'REQ-003',
        title: 'Batas maksimal transaksi per batch',
        description: 'Maksimal 500 transaksi per batch. Batch yang melebihi batas akan ditolak.',
        category: 'Constraint',
        source_references: [
          {
            document_id: 'DOC-002',
            page: 2,
            section: 'Batch Size Limits',
            quote: 'Maximum 500 transactions per batch.',
          },
        ],
        ambiguities: [],
        conflicts: [
          {
            message:
              'CONFLICT DETECTED - batch size: DOC-001 states 300 transactions; DOC-002 states 500 transactions. Human resolution required.',
            source_references: [{ document_id: 'DOC-001', page: null, section: null, quote: null }],
            resolved: false,
            resolution_note: null,
          },
        ],
      },
      {
        requirement_id: 'REQ-004',
        title: 'Notifikasi dikirim sesuai kebutuhan',
        description:
          'Sistem mengirim notifikasi kepada nasabah sesuai kebutuhan apabila diperlukan.',
        category: 'Expected Behavior',
        source_references: [
          {
            document_id: 'DOC-001',
            page: null,
            section: 'Ketentuan',
            quote: 'Notifikasi dikirim sesuai kebutuhan.',
          },
        ],
        ambiguities: ['Condition is discretionary, with no stated trigger.'],
        conflicts: [],
      },
    ],
    test_cases: [],
  };
}

/** A well-formed reply, of the kind a working provider returns. */
export function sampleLlmResponse(overrides = {}) {
  return {
    project: {
      project_description:
        'BI-FAST Overdraft extends the existing BI-FAST transfer flow with overdraft handling and participant status routing.',
      project_summary:
        'The project adds overdraft support to BI-FAST outgoing transfers, tightens BIC Code validation, and enforces batch size limits.',
      qa_guidance:
        'Focus on BIC Code validation boundaries, participant status routing, and batch size enforcement. The batch limit is disputed between documents, so confirm the agreed value before executing those cases.',
      sit_scope: [
        'BIC Code Validation: Validating mandatory presence and 8 or 11 character length, including the ADMI 002 rejection path.',
        'Participant Status Routing: Validating transaction behavior based on Active vs. Suspended participant bank statuses.',
        'Batch Size Enforcement: Validating acceptance and rejection of batches at the stated transaction limit.',
      ],
      project_background:
        'BI-FAST Overdraft introduces overdraft handling to the existing outgoing transfer flow. SIT covers the validation, routing and batch limit behaviour described in the PRD and the accompanying RFC.',
    },
    test_cases: [
      {
        requirement_ids: ['REQ-001'],
        section: 'BIC Code Validation',
        test_case: 'Verify transaksi berhasil dengan BIC Code 8 karakter yang valid.',
        case_type: 'Positive',
        edge_polarity: null,
        priority: 'High',
        type: 'Functional',
        expected_result: 'Transaksi diterima dan diteruskan ke BI-FAST tanpa error validasi.',
        confidence: 'High',
        warnings: [],
      },
      {
        requirement_ids: ['REQ-001'],
        section: 'BIC Code Validation',
        test_case: 'Verify penolakan transaksi ketika field BIC Code dikosongkan.',
        case_type: 'Negative',
        edge_polarity: null,
        priority: 'High',
        type: 'Functional',
        expected_result: 'Transaksi ditolak dengan error ADMI 002 dan tidak diteruskan ke BI-FAST.',
        confidence: 'High',
        warnings: [],
      },
      {
        requirement_ids: ['REQ-002'],
        section: 'Participant Status Routing',
        test_case: 'Verify penolakan transaksi ke bank peserta berstatus Suspended.',
        case_type: 'Negative',
        edge_polarity: null,
        priority: 'Critical',
        type: 'Functional',
        expected_result: 'Transaksi ditolak dan tidak diteruskan ke BI-FAST.',
        confidence: 'High',
        warnings: [],
      },
      {
        requirement_ids: ['REQ-003'],
        section: 'Batch Size Enforcement',
        test_case: 'Verify batch berisi tepat 500 transaksi diproses sampai selesai.',
        case_type: 'Edge',
        edge_polarity: 'valid',
        priority: 'Medium',
        type: 'Functional',
        expected_result: 'Batch diproses penuh dan seluruh 500 transaksi tercatat.',
        confidence: 'Medium',
        warnings: [
          {
            code: 'INSUFFICIENT_INFORMATION',
            message: 'The batch limit is stated as 500 in DOC-002 but 300 in DOC-001.',
          },
        ],
      },
      {
        requirement_ids: ['REQ-003'],
        section: 'Batch Size Enforcement',
        test_case: 'Verify penolakan batch berisi 501 transaksi.',
        case_type: 'Edge',
        edge_polarity: 'invalid',
        priority: 'Medium',
        type: 'Functional',
        expected_result: 'Batch ditolak dan tidak ada transaksi yang diproses.',
        confidence: 'Medium',
        warnings: [],
      },
    ],
    warnings: [
      {
        code: 'INSUFFICIENT_INFORMATION',
        message:
          'REQ-004 states notifications are sent "sesuai kebutuhan" with no stated trigger, channel or content, so no test case can be defined safely.',
        requirement_id: 'REQ-004',
      },
    ],
    ...overrides,
  };
}
