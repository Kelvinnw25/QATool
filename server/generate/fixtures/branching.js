/**
 * Requirements that state several independent branches, and the replies a
 * generator can give to them.
 *
 * These reproduce the shape of defects measured against a real PRD. Gemini #1
 * reconstructs the fragmented GIVEN/WHEN/THEN blocks correctly, and Gemini #2
 * then either compresses a requirement's branches into one oversized test case,
 * or writes a thin case that drops the context, the named systems and the
 * stated conditions that made the scenario testable.
 *
 * The wording is synthetic. Only the structure is taken from the observed run,
 * and the named systems are invented placeholders - the repository keeps client
 * system names out of fixtures, and the properties under test (a named
 * integration path survives into the case instead of being generalised) hold
 * just as well for invented names:
 *
 *   REQ-001  conditional verification with four outcomes, one a retry with a
 *            limit and a different final outcome
 *   REQ-002  a search filter that states BOTH a configuration obligation (the
 *            control exists, is placed somewhere, offers exactly these options)
 *            and three behavioural ones
 *   REQ-003  a selection behaviour meaningful only inside a context (a tab, an
 *            action, a page size)
 *   REQ-004  an integration path naming the system called and the middleware it
 *            travels through, plus a mapping that an example must not replace
 *   REQ-005  a scheduled report with many stated acceptance conditions, and one
 *            vague word that must NOT become a measurable threshold
 *
 * Four replies, because granularity has more than one failure mode:
 * `collapsedLlmResponse` is the oversized defect, `thinLlmResponse` is the
 * detail-dropping defect, `branchedLlmResponse` is the wanted output, and
 * `overSplitLlmResponse` is the over-correction deduplication must still catch.
 */
export function branchingCanonicalInput() {
  return {
    project: { project_name: 'Settlement Report', sit_scope: [] },
    documents: [
      {
        document_id: 'DOC-001',
        filename: 'PRD Settlement Report (synthetic).docx',
        document_type: 'PRD',
        status: 'Extracted',
        page_count: null,
        extracted_char_count: 9840,
      },
    ],
    requirements: [
      {
        requirement_id: 'REQ-001',
        title: 'Verifikasi status dan retry bersyarat',
        description:
          'Sistem melakukan verifikasi status transaksi ke payment provider. Jika status yang diterima adalah SUCCESS, transaksi ditandai settled dan settlement record dibuat. Jika status yang diterima adalah FAILED atau NOT FOUND, sistem memicu retry Release Settlement. Jika retry ke-1 atau ke-2 masih timeout, sistem melakukan Check Status kembali. Retry dilakukan maksimal 3 kali; jika setelah retry ke-3 status masih belum terselesaikan, transaksi ditandai permanently FAILED.',
        category: 'Business Rule',
        source_references: [
          {
            document_id: 'DOC-001',
            page: null,
            section: 'Settlement > Status Verification',
            quote:
              'SUCCESS -> settled. FAILED / NOT FOUND -> retry Release Settlement. Retry ke-1/ke-2 timeout -> Check Status kembali. Maksimal 3 retry; belum selesai setelah retry ke-3 -> permanently FAILED.',
          },
        ],
        ambiguities: [],
        conflicts: [],
      },
      {
        requirement_id: 'REQ-002',
        title: 'Advanced Search filter Settlement Status',
        description:
          'Pada Advanced Search halaman Settlement Report tersedia dropdown Settlement Status yang diletakkan tepat di bawah field Settlement Type. Pilihan yang tersedia hanya Settled, Unsettled, dan Settled & Unsettled. Pilihan Settled menampilkan hanya transaksi yang sudah settled. Pilihan Unsettled menampilkan hanya transaksi yang belum settled. Pilihan Settled & Unsettled menampilkan kedua jenis transaksi dalam satu hasil pencarian.',
        category: 'Expected Behavior',
        source_references: [
          {
            document_id: 'DOC-001',
            page: null,
            section: 'Settlement Report > Advanced Search',
            quote:
              'Dropdown Settlement Status di bawah Settlement Type. Opsi: Settled | Unsettled | Settled & Unsettled.',
          },
        ],
        ambiguities: [],
        conflicts: [],
      },
      {
        requirement_id: 'REQ-003',
        title: 'Select All terbatas pada halaman aktif',
        description:
          'Pada halaman Settlement Report, setelah user menekan action Release dengan Settlement Type HOLD, checkbox Select All ditampilkan di dekat tabel transaksi. Select All hanya memilih baris pada halaman yang sedang aktif, dan satu halaman memuat maksimal 10 baris. Menghapus centang Select All membatalkan pilihan pada halaman aktif saja, sedangkan pilihan pada halaman lain tidak terpengaruh.',
        category: 'Expected Behavior',
        source_references: [
          {
            document_id: 'DOC-001',
            page: null,
            section: 'Settlement Report > Release (HOLD)',
            quote:
              'Select All: hanya baris pada halaman aktif (maksimal 10 baris per halaman); halaman lain tidak terpengaruh.',
          },
        ],
        ambiguities: [],
        conflicts: [],
      },
      {
        requirement_id: 'REQ-004',
        title: 'Check Status ke core system melalui middleware',
        description:
          'Sistem melakukan Check Status ke core system CORE-T1 melalui middleware MIDSVC. Apabila response yang diterima adalah SUCCESS, status pada database diperbarui menjadi SUCCESS dan REFERENCE NUMBER yang dikembalikan disimpan pada record transaksi sesuai mapping response yang ditetapkan. Contoh pada dokumen menampilkan REFERENCE NUMBER 250101ABCDEF sebagai ilustrasi format.',
        category: 'Integration/Dependency',
        source_references: [
          {
            document_id: 'DOC-001',
            page: null,
            section: 'Integration > Check Status',
            quote:
              'Check Status -> CORE-T1 via MIDSVC. Response SUCCESS -> DB status SUCCESS, REFERENCE NUMBER disimpan sesuai mapping. Contoh: 250101ABCDEF.',
          },
        ],
        ambiguities: [],
        conflicts: [],
      },
      {
        requirement_id: 'REQ-005',
        title: 'Daily report settlement terjadwal',
        description:
          'Setelah seluruh transaksi D-1 selesai, scheduler otomatis membuat daily report pada pukul 03.00 AM di luar jam sibuk tanpa intervensi manual. Rentang data adalah D-1 pukul 00.00 sampai 23.59 dan wajib menyertakan transaksi H+1 serta transaksi On Hold. Proses tidak boleh meninggalkan file sementara .tmp. File dihasilkan dalam format .txt dengan delimiter tilde (~), dinamai SETTLEMENT_QRMANAGER_DDMMYYYY.txt mengikuti Transaction Date, dan disimpan pada direktori yang telah ditentukan. Report harus tersedia dengan cepat.',
        category: 'Constraint',
        source_references: [
          {
            document_id: 'DOC-001',
            page: null,
            section: 'Reporting > Daily Report',
            quote:
              'Scheduler 03.00 AM, D-1 00.00-23.59, termasuk H+1 dan On Hold, tanpa file .tmp, format .txt delimiter ~, nama SETTLEMENT_QRMANAGER_DDMMYYYY.txt sesuai Transaction Date.',
          },
        ],
        ambiguities: [],
        conflicts: [],
      },
    ],
    test_cases: [],
  };
}

function projectOutputs() {
  return {
    project_description:
      'Settlement Report adds status verification, advanced search, bulk selection and a scheduled daily report to the settlement monitoring screen.',
    project_summary:
      'The project verifies transaction settlement status through the core integration, retries unresolved releases within a limit, lets an operator search and select settlement records, and produces a scheduled daily report file.',
    qa_guidance:
      'Focus on the separate verification and retry outcomes, on the Settlement Status control as well as each of its filter options, on the page scope of Select All within the HOLD release flow, and on the stated scheduling, naming and format conditions of the daily report.',
    sit_scope: [
      'Status Verification: Validating the settled, retry, re-check and permanently failed outcomes of status verification.',
      'Advanced Search: Validating the Settlement Status control and each documented filter option.',
      'Bulk Selection: Validating that Select All in the HOLD release flow is scoped to the active page.',
      'Integration: Validating Check Status through the middleware and the response mapping written to the record.',
      'Daily Report: Validating the scheduled generation window, content, naming and format conditions.',
    ],
    project_background:
      'Settlement Report gives operations a single screen for reconciling settlement status. SIT covers the verification outcomes, the retry limit, the search control and its options, the bulk selection scope, the core integration path and the scheduled daily report described in the PRD.',
  };
}

function testCase(overrides) {
  return {
    requirement_ids: ['REQ-001'],
    section: 'Status Verification',
    case_type: 'Positive',
    edge_polarity: null,
    priority: 'High',
    type: 'Functional',
    confidence: 'High',
    warnings: [],
    ...overrides,
  };
}

/**
 * The oversized defect: one test case per requirement, whatever it says.
 *
 * The first is unexecutable as written - it asks a tester to drive four
 * provider outcomes and three retries in one run - and when it fails, nothing
 * records which branch failed.
 */
export function collapsedLlmResponse() {
  return {
    project: projectOutputs(),
    test_cases: [
      testCase({
        test_case:
          'Verify verifikasi status transaksi dan mekanisme retry berjalan sesuai ketentuan.',
        expected_result:
          'Transaksi ditandai settled saat SUCCESS, retry Release Settlement dipicu saat FAILED atau NOT FOUND, Check Status diulang saat retry timeout, dan transaksi menjadi permanently FAILED setelah retry ke-3.',
      }),
      testCase({
        requirement_ids: ['REQ-002'],
        section: 'Advanced Search',
        test_case: 'Verify filter Settlement Status pada Advanced Search berfungsi.',
        expected_result:
          'Hasil pencarian sesuai dengan pilihan Settled, Unsettled, maupun Settled & Unsettled.',
      }),
      testCase({
        requirement_ids: ['REQ-003'],
        section: 'Bulk Selection',
        test_case: 'Verify checkbox Select All berfungsi.',
        expected_result: 'Baris pada halaman yang sedang dibuka terpilih.',
      }),
    ],
    warnings: [],
  };
}

/**
 * The detail-dropping defect: the branches are separated, but each case has
 * been stripped of what made it testable.
 *
 * Context gone ("Select All works"), the named integration path generalised
 * into its category, the stated report conditions reduced to "a report is
 * produced", an illustrative reference number promoted into an assertion, and
 * expected results that cannot be observed. Nothing deterministic can detect
 * this - it is here so the instruction tests have the defect they describe.
 */
export function thinLlmResponse() {
  return {
    project: projectOutputs(),
    test_cases: [
      testCase({
        requirement_ids: ['REQ-003'],
        section: 'Bulk Selection',
        test_case: 'Verify Select All berfungsi.',
        expected_result: 'Select All bekerja dengan benar.',
      }),
      testCase({
        requirement_ids: ['REQ-004'],
        section: 'Integration',
        test_case: 'Verify Check Status ke core banking.',
        expected_result: 'Core banking mengembalikan success dan REFERENCE NUMBER 250101ABCDEF.',
      }),
      testCase({
        requirement_ids: ['REQ-005'],
        section: 'Daily Report',
        test_case: 'Verify daily report dibuat.',
        expected_result: 'Report tersedia dalam waktu kurang dari 5 detik.',
      }),
    ],
    warnings: [],
  };
}

/**
 * The wanted output: one test case per executable scenario, each keeping the
 * context, the named systems and the stated conditions.
 *
 * Twelve cases from five requirements. What is NOT split matters as much: the
 * SUCCESS case confirms the settled status and the settlement record together
 * because they are one outcome of one action; FAILED and NOT FOUND share a case
 * because the source gives them the same outcome; retry attempts 1 and 2 share
 * a case because the source gives them the same behaviour; and the daily report
 * conditions that hold within one generation run stay in one case.
 */
export function branchedLlmResponse() {
  return {
    project: projectOutputs(),
    test_cases: [
      testCase({
        test_case:
          'Verify transaksi ditandai settled ketika payment provider mengembalikan status SUCCESS.',
        expected_result:
          'Transaksi berubah menjadi settled dan settlement record terbentuk untuk transaksi tersebut.',
      }),
      testCase({
        case_type: 'Negative',
        test_case:
          'Verify retry Release Settlement dipicu ketika Check Status mengembalikan FAILED atau NOT FOUND.',
        expected_result:
          'Sistem memicu retry Release Settlement untuk transaksi tersebut dan status belum ditandai settled.',
      }),
      testCase({
        test_case:
          'Verify sistem melakukan Check Status kembali ketika retry Release Settlement ke-1 atau ke-2 masih timeout.',
        expected_result:
          'Setelah retry ke-1 atau ke-2 timeout, sistem menjalankan Check Status kembali dan transaksi belum ditandai permanently FAILED.',
      }),
      testCase({
        case_type: 'Edge',
        edge_polarity: 'invalid',
        priority: 'Critical',
        test_case:
          'Verify transaksi ditandai permanently FAILED ketika status masih belum terselesaikan setelah retry ke-3.',
        expected_result:
          'Setelah retry ke-3 dan status belum terselesaikan, transaksi ditandai permanently FAILED dan tidak ada retry berikutnya.',
      }),
      testCase({
        requirement_ids: ['REQ-002'],
        section: 'Advanced Search',
        test_case:
          'Verify dropdown Settlement Status tampil tepat di bawah field Settlement Type pada Advanced Search dan hanya memuat opsi Settled, Unsettled, serta Settled & Unsettled.',
        expected_result:
          'Dropdown Settlement Status tampil tepat di bawah Settlement Type dan daftar opsinya persis Settled, Unsettled, dan Settled & Unsettled tanpa opsi lain.',
      }),
      testCase({
        requirement_ids: ['REQ-002'],
        section: 'Advanced Search',
        test_case: 'Verify Advanced Search dengan Settlement Status "Settled".',
        expected_result: 'Hasil pencarian hanya menampilkan transaksi yang sudah settled.',
      }),
      testCase({
        requirement_ids: ['REQ-002'],
        section: 'Advanced Search',
        test_case: 'Verify Advanced Search dengan Settlement Status "Unsettled".',
        expected_result: 'Hasil pencarian hanya menampilkan transaksi yang belum settled.',
      }),
      testCase({
        requirement_ids: ['REQ-002'],
        section: 'Advanced Search',
        test_case: 'Verify Advanced Search dengan Settlement Status "Settled & Unsettled".',
        expected_result:
          'Hasil pencarian menampilkan transaksi settled dan unsettled dalam satu hasil.',
      }),
      testCase({
        requirement_ids: ['REQ-003'],
        section: 'Bulk Selection',
        test_case:
          'Verify checkbox Select All pada action Release dengan Settlement Type HOLD hanya memilih baris pada halaman aktif yang memuat maksimal 10 baris.',
        expected_result:
          'Seluruh baris pada halaman aktif (maksimal 10 baris) terpilih, sedangkan baris pada halaman lain tidak ikut terpilih.',
      }),
      testCase({
        requirement_ids: ['REQ-003'],
        section: 'Bulk Selection',
        case_type: 'Negative',
        test_case:
          'Verify menghapus centang Select All pada halaman aktif tab Release HOLD membatalkan pilihan halaman tersebut saja.',
        expected_result:
          'Pilihan pada halaman aktif dibatalkan seluruhnya dan pilihan pada halaman lain tetap tidak terpengaruh.',
      }),
      testCase({
        requirement_ids: ['REQ-004'],
        section: 'Integration',
        test_case:
          'Verify Check Status ke core system CORE-T1 melalui middleware MIDSVC ketika response yang diterima adalah SUCCESS.',
        expected_result:
          'Status pada database diperbarui menjadi SUCCESS dan REFERENCE NUMBER dari response tersimpan pada record transaksi sesuai mapping response yang ditetapkan.',
      }),
      testCase({
        requirement_ids: ['REQ-005'],
        section: 'Daily Report',
        test_case:
          'Verify scheduler otomatis membuat daily report pada pukul 03.00 AM setelah seluruh transaksi D-1 selesai, tanpa intervensi manual.',
        expected_result:
          'File SETTLEMENT_QRMANAGER_DDMMYYYY.txt sesuai Transaction Date terbentuk di direktori yang ditentukan dengan delimiter tilde (~), berisi transaksi D-1 pukul 00.00-23.59 termasuk H+1 dan On Hold, dan tidak menyisakan file .tmp.',
      }),
    ],
    warnings: [],
  };
}

/**
 * The over-correction: the same scenario written twice.
 *
 * Splitting must not become a way to raise a count, so an identical action is
 * still removed by deduplication and the removal is announced.
 */
export function overSplitLlmResponse() {
  const response = branchedLlmResponse();

  response.test_cases.push(
    testCase({
      test_case:
        'Verify transaksi ditandai settled ketika payment provider mengembalikan status SUCCESS.',
      expected_result: 'Transaksi menjadi settled.',
    })
  );

  return response;
}
