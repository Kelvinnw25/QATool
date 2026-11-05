# QAI — Blueprint v4 · P0 Refinement

> **Status:** Arsitektur P0 kanonik, belum diimplementasikan.
> **Tanggal:** 31 Oktober 2026.
> **Berlaku untuk:** QAI P0. Dokumen ini adalah *scoped update* resmi atas `QAI_Blueprint_v4.md`. Blueprint v4 tetap dipertahankan apa adanya sebagai baseline historis. Bila ada pertentangan untuk lingkup P0, **dokumen ini yang berlaku**. Bagian yang di-supersede tercantum di §16.
> **Menggantikan:** penilaian arsitektur 2026-10-31 (`scratchpad/qai-migration/ARCHITECTURE_ASSESSMENT.md`: 5 panggilan LLM, 3 gerbang approval, obligation dipertahankan). Penilaian itu tidak berlaku lagi.

Label: **[F]** fakta repo yang diverifikasi (file:baris), **[R]** hasil benchmark/laporan sebelumnya (di luar repo, scratchpad sesi), **[D]** keputusan arsitektur, **[A]** asumsi, **[U]** isu yang belum terselesaikan (§19).

---

## 1. Filosofi produk dan non-goals

**AI generates. QA evaluates.** [D]

QAI adalah asisten QA berbasis AI, bukan mesin approval atau sertifikasi otomatis. QAI membantu QA:

1. memahami PRD dan konteks bisnisnya;
2. mengenali perilaku penting dan area yang butuh perhatian;
3. menghasilkan test case yang berguna dan komprehensif;
4. menyerahkan hasilnya dalam Excel untuk direview QA secara manual.

QA adalah pengambil keputusan akhir. **Deliverable utama adalah file Excel test case.**

**Non-goals P0** [D]:
- Gerbang approval di dalam pipeline sebelum output.
- Reviewer LLM, PRD Reviewer, Test Plan Generator, atau Test Intent Generator yang wajib.
- Klaim bahwa coverage perilaku sudah lengkap.
- Blocking gate berbasis penilaian kualitas subjektif.
- Perubahan format Excel selain highlight baris merah (§11).
- Database, workflow engine, event bus, atau orkestrasi multi-agent.
- Pindah stack ke FastAPI/Next.js.

---

## 2. Fakta repo yang menjadi dasar

| Fakta [F] | Bukti |
|---|---|
| Stack: Node ≥22 ESM, Fastify 5, Zod 4, pdfjs-dist, fflate; frontend React + Vite | `package.json` (versi `1.0.0-m1`) |
| Pipeline sekarang punya 3 panggilan LLM: #1 strukturisasi, #2 generasi, #3 review semantik (opt-in) | `server/structure/index.js:101`, `server/generate/index.js:253`, `server/semantic/index.js` |
| Server stateless; tidak ada tulis ke disk; ditegakkan tes | `server/routes/pipeline.js:17-28`, `server/no-persistence.test.js:32,75` |
| #1 hanya mengutip `source_block_id`; teks requirement dibangun ulang verbatim oleh sistem | `server/structure/prompt.js:24-26`, `server/structure/validate.js:8-22`, `server/extract/blocks.js:75-88` |
| ID test case dan source reference ditentukan kode, bukan model | `server/generate/contract.js:26-35`, `server/generate/assemble.js:150,223` |
| Prompt #2 sekarang: "never guess", kasus yang tidak didukung diganti warning `INSUFFICIENT_INFORMATION`; input hanya requirement, bukan teks dokumen | `server/generate/prompt.js:9-18,25-42` |
| `project_description` sekarang: satu kalimat, ≤300 karakter, ditolak bila dilanggar | `server/schema/project.js:17-24`, `server/generate/prompt.js:191` |
| Provider: satu metode `generateJson({system, prompt, schema, signal})`, registry `{gemini, mock}` | `server/llm/provider.js` |
| Output terpotong (`finishReason=MAX_TOKENS`) menjadi error `LLM_TRUNCATED`, tidak dipakai sebagian | `server/llm/gemini.js:182-186` |
| Workbook: 1 sheet `Sheet1`, 9 kolom, header dibaca dari template | `templates/sit-script-template.xlsx`, `server/export/template.js:62-135` |
| Data mulai baris 2; style per kolom hanya `2` (center, border, tanpa fill) dan `4` (left, border, tanpa fill) | `server/export/template.js:19-33`, `server/export/sheet-builder.js` |
| Template tidak punya fill merah; fills yang ada: none, lightGray, kuning, putih, `F6F8F9` | `xl/styles.xml` di template |
| Excel Table `Table_1` hanya di kolom C, style `Sheet1-style` dengan row stripes | `xl/tables/table1.xml` di template |
| Semua part selain sheet, sharedStrings, table disalin byte-per-byte (termasuk `styles.xml`) | `server/export/sit-script-export.js` ("Styles ... are never regenerated"), tes `every non-regenerated part is copied through byte-for-byte` |
| Workbook tidak punya kolom requirement/traceability | header template (§11.1) |

### 2.1 Dependensi transitif ke `obligations.js` [F]

Dihitung dari graf `import` statis (relatif) per modul:

| Menarik `scenario/obligations.js` | Bersih (bisa dipakai ulang QAI) |
|---|---|
| `extract/index.js` (via `structure/index.js` → `recover.js`) | `extract/parsers/*`, `extract/blocks.js`, `extract/detect.js`, `extract/requirements.js` |
| `structure/index.js`, `structure/recover.js` | `structure/prompt.js`, `structure/contract.js`, `structure/validate.js`, `structure/test-points.js` |
| `generate/index.js`, `generate/prompt.js`, `generate/claims.js` | `generate/contract.js`, `generate/assemble.js` |
| `schema/canonical.js` | `schema/testcase.js`, `schema/requirement.js`, `schema/project.js`, `schema/common.js` |
| `semantic/index.js` | `semantic/testcase-diagnostics.js` (`semantic/heuristics.js` menarik `checklist.js`) |
| `routes/pipeline.js` | `export/*`, `llm/*`, `lib/*` |

Konsekuensi [D]: jalur QAI **tidak boleh** memanggil `extractDocuments`, `structureRequirements`, `generateFromRequirements`, `buildCoverage`, `checkCanonicalReferences` (dari `canonical.js`), atau `reviewSemantics`. Jalur QAI menyusun ulang dari modul yang bersih.

---

## 3. Pipeline P0 final: dua panggilan LLM utama

```text
UPLOAD PRD
    |
    v
DOCUMENT EXTRACTION                       deterministik
    |-- source/<file asli>
    |-- extracted_prd.json
    v
UNDERSTAND PRD                            LLM CALL #1
    |-- Project Description
    |-- QA Guidance
    |-- SIT Scope
    |-- Project Background
    |-- Context Understanding
    |-- Attention Areas
    |-- Requirement grouping (block id)
    v
SCHEMA VALIDATION                         deterministik
    v
PERSIST UNDERSTANDING ARTIFACT            deterministik, atomik
    |-- understanding.json
    |-- update run_metadata.json
    v
LOAD PERSISTED ARTIFACT                   deterministik, cek integritas
    |-- extracted_prd.json (sumber kebenaran)
    |-- understanding.json
    v
GENERATE TEST CASES                       LLM CALL #2
    |-- konten test case
    |-- referensi requirement / blok sumber
    |-- metadata review internal
    v
PERSIST TESTCASE ARTIFACT                 deterministik, atomik
    |-- testcases.json
    |-- update run_metadata.json
    v
BASIC DETERMINISTIC VALIDATION            deterministik, non-blocking kecuali struktural
    v
XLSX EXPORT                               deterministik
    |-- struktur, kolom, gaya penulisan XLSX yang ada
    |-- fill merah muda hanya untuk baris yang ditandai
    v
QA MANUAL REVIEW                          manusia
    |-- review · edit · hapus · tambah
    v
FINAL QA TESTCASE
```

[D] Tidak ada gerbang approval antara Understand PRD dan Generate Test Cases. Stage 1 dan Stage 2 berjalan berurutan dan otomatis dalam satu run. `understanding.json` adalah serah-terima internal pipeline, **bukan** checkpoint approval QA.

[D] Pipeline normal memakai **tepat dua** panggilan LLM. Tidak ada panggilan tambahan untuk review, repair, atau retry otomatis. Retry Stage 2 hanya atas aksi pengguna (§9).

---

## 4. Document Extraction

[D] **Keep.** Pakai parser yang ada (`extract/parsers/pdf.js`, `docx.js`, `xlsx.js`, `transcription.js`) dan `extract/blocks.js` (`assignBlockIds`, `buildSourceReference`). Parser tidak didesain ulang.

[D] Karena `extract/index.js` menarik obligation (§2.1), QAI memanggil parser dan `assignBlockIds` langsung dari modul ekstraksi QAI.

Output `extracted_prd.json`:

```jsonc
{
  "artifact": "extracted_prd",
  "schema_version": "qai.p0.extracted_prd/1",
  "run_id": "…",
  "documents": [
    { "document_id": "DOC-001", "filename": "…", "document_type": "PRD",
      "mime_type": "…", "size_bytes": 0, "sha256": "…",
      "page_count": 0, "extracted_char_count": 0, "status": "Extracted" }
  ],
  "blocks": [
    { "source_block_id": "DOC-001-B014", "document_id": "DOC-001",
      "page": 3, "section": "…", "kind": "paragraph", "text": "…" }
  ],
  "warnings": [ { "code": "UNREAD_IMAGE_CONTENT", "document_id": "DOC-001", "message": "…" } ]
}
```

- Peringatan ekstraksi yang ada dipertahankan: `LOW_EXTRACTED_TEXT`, `UNREAD_IMAGE_CONTENT`, `PARSER_LIMITATION`, `DOCUMENT_FAILED`.
- File asli disimpan di `source/` (§8). SHA-256 file asli dan SHA-256 `extracted_prd.json` dicatat di `run_metadata.json`.
- PRD asli dan `extracted_prd.json` adalah sumber kebenaran sepanjang pipeline.

---

## 5. Stage 1 — Understand PRD (LLM Call #1)

### 5.1 Input

- Seluruh blok dari `extracted_prd.json` dengan `source_block_id`, halaman, section, dan teks. Format blok mengikuti prompt #1 yang ada (`structure/prompt.js`, `buildStructurePrompt`), termasuk penanganan anggaran ukuran yang sudah ada (`SOURCE_TRUNCATED` bila blok tidak terkirim).
- Metadata dokumen (nama file, tipe dokumen, jumlah halaman).
- [D] Konten dokumen dibungkus sebagai data tak tepercaya: instruksi sistem menyatakan teks di dalam blok adalah bahan analisis, bukan instruksi (prinsip Blueprint §10.5). Ini belum ada di prompt sekarang [F].

### 5.2 Output model (kontrak LLM)

[D] Stage 1 menggabungkan strukturisasi requirement #1 yang ada (merge) dengan pemahaman PRD. Bagian grouping memakai ulang kontrak `structure/contract.js` tanpa perubahan semantik. Model tetap **tidak menulis teks requirement dan tidak membuat ID**.

```jsonc
{
  "project_description": "string, wajib, tanpa batas panjang",
  "qa_guidance": "string, wajib",
  "sit_scope": ["string", "3 sampai 5 item"],
  "project_background": "string, wajib, tepat satu paragraf",
  "context": {
    "system_overview": "string",
    "business_flows":   [ { "name": "…", "description": "…", "source_block_ids": ["…"] } ],
    "actors":           [ { "name": "…", "responsibility": "…", "source_block_ids": ["…"] } ],
    "lifecycle":        [ { "state_or_step": "…", "description": "…", "source_block_ids": ["…"] } ],
    "business_rules":   [ { "rule": "…", "source_block_ids": ["…"] } ],
    "dependencies":     [ { "name": "…", "description": "…", "source_block_ids": ["…"] } ]
  },
  "attention_areas": [
    {
      "category": "edge_case | ambiguity | unclear_rule | missing_condition | exceptional_flow | potential_gap | multiple_interpretation | integration_risk | negative_flow",
      "title": "…",
      "description": "apa yang perlu diperhatikan QA dan kenapa",
      "source_block_ids": ["DOC-001-B014"]
    }
  ],
  "requirements":      [ /* persis kontrak structure/contract.js: title, source_block_ids, test_points, ambiguous, conflicted, fragmented */ ],
  "supporting_blocks": [ /* persis kontrak structure/contract.js: source_block_ids, role, reason */ ]
}
```

Aturan isi [D]:
- **Project Description:** komprehensif. Tidak ada batas karakter di prompt, schema, API, validasi server, maupun frontend. Tidak pernah dipotong. Satu-satunya batas adalah batas fisik provider (`maxOutputTokens`); output yang terpotong menjadi `LLM_TRUNCATED` dan Stage 1 gagal, tidak dipakai sebagian [F `gemini.js:182-186`].
- **QA Guidance:** fokus SIT, menekankan edge case, requirement ambigu, aturan bisnis yang tidak jelas, kondisi yang hilang, alur pengecualian, potensi gap, dan perilaku yang bisa ditafsirkan berbeda. Ini **panduan perhatian**, bukan checklist wajib, dan tidak membatasi Stage 2.
- **SIT Scope:** 3–5 poin ringkas tentang apa yang termasuk SIT.
- **Project Background:** tepat satu paragraf untuk sirkulasi undangan SIT.
- **Context & Attention Areas:** dipakai Stage 2, bukan untuk approval. Setiap item mengutip `source_block_ids` bila ada; model dilarang mengarang ID. Item tanpa sumber yang bisa dikutip boleh ada dengan `source_block_ids: []`.
- Bahasa: keempat field proyek tetap **English**, mengikuti konvensi yang ada [F `generate/prompt.js` "These five fields are ALWAYS English"]. [A] Context dan attention area juga English, karena dipakai sebagai input model, tidak ditampilkan di Excel.

### 5.3 Validasi Stage 1 (deterministik)

1. Parse Zod strict untuk seluruh output. Field wajib tidak boleh kosong setelah trim.
2. `sit_scope` berisi 3–5 item tidak kosong.
3. `project_background` satu paragraf: tidak mengandung baris kosong (`\n\s*\n`). Ini cek struktur, bukan cek panjang.
4. Grouping: `reconstructRequirements` dari `structure/validate.js` [F]. Requirement dibangun ulang verbatim dari blok; ID `REQ-nnn` diberikan sistem. Minimal 1 requirement harus bisa dibangun.
5. Setiap `source_block_ids` di context dan attention area harus ada di `extracted_prd.json`. ID yang tidak ada **dibuang dari item itu** dan dicatat sebagai warning `UNKNOWN_SOURCE_BLOCK` (perilaku yang sama dengan #1 sekarang: "Only a citation that cannot be resolved is dropped" [F `structure/validate.js:21`]). Tidak ada pencocokan teks untuk menebak ID.
6. Sistem memberi ID attention area `AA-001`, `AA-002`, … sesuai urutan array, mengikuti prinsip "identifier dibuat kode, bukan model" [F `generate/contract.js:26-31`].
7. Sistem menurunkan `requirement_ids` per attention area dari pemetaan blok → requirement. Page/section diturunkan dari blok, tidak ditulis model.

Gagal di langkah 1–4 → Stage 1 **gagal** (§9). Langkah 5–7 tidak pernah menggagalkan stage.

[D] **Tidak ada fallback deterministik** di jalur QAI. Fallback fail-soft #1 yang sekarang (`structure/index.js` `deterministic()`) di-supersede untuk QAI: bila Stage 1 gagal, Stage 2 tidak dijalankan. Alasannya: Stage 2 butuh konteks Stage 1, dan run yang diam-diam berjalan dengan konteks kosong menyesatkan. [U-9]

[D] **Recovery blok perilaku dihapus dari jalur QAI** (`structure/recover.js` memakai obligation detector). Fungsi perlindungannya, yaitu perilaku tidak hilang karena model menyisihkan blok, dipenuhi dengan cara lain: Stage 2 menerima seluruh `extracted_prd.json`, termasuk blok yang disisihkan Stage 1 (§7.1). Traceability untuk kasus semacam ini: §7.3 dan [U-1].

### 5.4 Artifact `understanding.json`

```jsonc
{
  "artifact": "understanding",
  "schema_version": "qai.p0.understanding/1",
  "run_id": "…",
  "source": {
    "extracted_prd_sha256": "…",
    "documents": [ { "document_id": "DOC-001", "sha256": "…" } ]
  },
  "model_output": { /* §5.2, persis seperti yang lolos validasi; tidak diubah */ },
  "derived": {
    "requirements":    [ /* objek requirement kanonik yang dibangun ulang sistem (schema/requirement.js) */ ],
    "attention_areas": [ { "attention_id": "AA-001", "index": 0, "requirement_ids": ["REQ-003"],
                           "source_references": [ { "document_id": "DOC-001", "page": 3, "section": "…", "quote": "…" } ] } ],
    "warnings": [ { "code": "UNKNOWN_SOURCE_BLOCK", "message": "…" } ]
  }
}
```

[D] Konten hasil LLM (`model_output`) dipisahkan dari data turunan sistem (`derived`) dan metadata eksekusi (yang berada di `run_metadata.json`, bukan di sini).

---

## 6. Stage 1 → Stage 2: serah-terima berbasis artifact

### 6.1 Urutan persistensi Stage 1 [D]

1. Validasi output (§5.3).
2. Susun objek `understanding.json` lengkap di memori.
3. Tulis atomik: tulis ke `understanding.json.tmp` di direktori run yang sama, `fsync`, lalu `rename` ke `understanding.json`. [A] Di Windows, `fs.rename` Node mengganti file target secara atomik pada volume yang sama.
4. Hitung SHA-256 file final.
5. Perbarui `run_metadata.json` (juga atomik): `stages.understanding.status = "succeeded"`, `artifact = "understanding.json"`, `artifact_sha256`, `finished_at`.
6. Baru setelah langkah 5 selesai, Stage 2 boleh dimulai.

Tidak ada file `understanding.json` yang ditulis bila validasi gagal. File `.tmp` sisa dari proses yang mati diabaikan dan dihapus saat run dibuka berikutnya.

### 6.2 Stage 2 memuat artifact yang dipersist [D]

Stage 2 selalu membaca `understanding.json` dan `extracted_prd.json` **dari direktori run-nya sendiri**, meskipun aplikasi masih memegang salinan di memori. Sebelum ada panggilan model, loader memeriksa:

| Cek | Bila gagal |
|---|---|
| `run_id` valid (format UUID) dan direktori ada | `RUN_NOT_FOUND` |
| `stages.understanding.status == "succeeded"` | `STAGE1_NOT_READY` |
| SHA-256 `understanding.json` sama dengan `stages.understanding.artifact_sha256` | `ARTIFACT_INTEGRITY` |
| `understanding.json.run_id` sama dengan run ini | `ARTIFACT_INTEGRITY` |
| `understanding.json.source.extracted_prd_sha256` sama dengan SHA-256 `extracted_prd.json` di run ini | `ARTIFACT_INTEGRITY` |
| `schema_version` dikenal dan file lolos parse Zod | `ARTIFACT_INTEGRITY` |

Gagal satu cek → Stage 2 `failed` dengan kode di atas, **tanpa memanggil model**. Ini mencegah artifact tidak lengkap, tidak valid, dari run lain, atau dari dokumen sumber lain ikut terpakai.

---

## 7. Stage 2 — Generate Test Cases (LLM Call #2)

### 7.1 Input

- **Sumber kebenaran:** seluruh blok `extracted_prd.json` (ID blok, halaman, section, teks).
- **Indeks requirement:** `REQ-nnn` → judul + `source_block_ids` (dari `understanding.derived.requirements`). Teks requirement tidak diulang, karena teksnya adalah blok itu sendiri; ini menghindari prompt berisi dua salinan dokumen.
- **Konteks Stage 1:** keempat field proyek, `context`, attention area dengan `AA-nnn`, `test_points` per requirement.
- **Konvensi penulisan yang ada**, dibawa tanpa diubah dari `generate/prompt.js`: granularity, completeness, examples & sample values, edge cases dan `edge_polarity`, "Writing the test case", "Writing the expected result", Language (test case dan expected result mengikuti bahasa dokumen; istilah teknis, nama field, kode error, dan nilai status tidak diterjemahkan), Priority, Type, frasa yang dilarang.

[D] Prioritas sumber dinyatakan eksplisit di prompt: PRD (blok) adalah otoritas; Stage 1 adalah konteks tambahan dan tidak boleh mengalahkan atau mengganti isi PRD.

[D] Ini men-supersede batas input generasi sekarang ("requirements only, never raw document text" [F `generate/prompt.js:9-18`]).

Yang **tidak** dimasukkan: daftar obligation, `obligation_plan`, checklist skenario (`scenario/checklist.js`), dan hasil heuristik apa pun.

### 7.2 Cakupan generasi [D]

Model diminta membuat test case untuk skenario normal/positif, negatif, boundary, edge, alur pengecualian, perilaku integrasi yang relevan, area requirement yang ambigu atau tidak lengkap, dan skenario bermakna lain dari pemahaman sistem. Generasi **tidak** dibatasi pada QA Guidance, skenario yang tersurat, daftar kata kunci, maupun pola obligation.

### 7.3 Kontrak output Stage 2

```jsonc
{
  "test_cases": [
    {
      "requirement_ids": ["REQ-003"],          // REQ yang dikutip; lihat [U-1] untuk blok di luar requirement
      "source_block_ids": ["DOC-001-B014"],    // opsional; blok yang langsung mendasari kasus
      "section": "…",
      "test_case": "…",
      "case_type": "Positive | Negative | Edge",
      "edge_polarity": "valid | invalid | null",
      "priority": "Critical | High | Medium | Low",
      "type": "Functional",
      "expected_result": "…",
      "review_required": false,
      "review_reason": null,
      "attention_area_ids": ["AA-002"]
    }
  ],
  "warnings": [ { "code": "INSUFFICIENT_INFORMATION", "requirement_id": "REQ-007", "message": "…" } ]
}
```

Perubahan dari kontrak #2 sekarang [D]:
- `project` dihapus dari Stage 2 (pindah ke Stage 1).
- `obligation_plan`, `draft_id`, dan `obligation_ids` dihapus.
- `confidence` dihapus dari kontrak QAI. Sinyal reviewnya digantikan `review_required`, dan field ini memang tidak diekspor [F `export/edge-case-mapping.js:182-194`]. [U-10]
- `review_required`, `review_reason`, `attention_area_ids` ditambahkan. `attention_area_ids` berupa enum dari ID yang dikirim di prompt, dengan pola yang sama seperti enum obligation sekarang [F `generate/contract.js:248-275`].
- `case_id`, `source_references`, `order_index`, `status`, dan `tested_by` tetap ditentukan kode, bukan model.

### 7.4 Ambiguitas dan asumsi [D]

Bila test case bergantung pada asumsi, aturan bisnis yang tidak jelas, expected behavior yang hilang, pernyataan PRD yang ambigu, atau tafsiran yang tidak dikonfirmasi sumber, maka:

1. tetap dibuat bila skenarionya berguna;
2. tidak dibuang diam-diam;
3. asumsi **tidak** ditulis sebagai aturan bisnis yang terkonfirmasi;
4. ditandai `review_required: true`;
5. diberi `review_reason` yang ringkas;
6. dikaitkan ke `attention_area_ids` bila relevan.

Model boleh mengusulkan expected result yang masuk akal. Bila expected result itu bergantung pada asumsi, kasusnya **wajib** ditandai. Kasus yang ditandai belum tentu salah; artinya hanya perlu diverifikasi manual.

Larangan yang tetap berlaku dari prompt sekarang: kode error, pesan, field, atau ambang yang tidak ada di sumber tidak boleh ditulis seolah fakta. Kasus berbasis asumsi harus menyatakan asumsinya, atau memakai expected result yang tidak mengklaim detail karangan.

Ini men-supersede aturan sekarang "produce no test case and record INSUFFICIENT_INFORMATION" [F `generate/prompt.js:32,42,84`]. `INSUFFICIENT_INFORMATION` tetap boleh dipakai sebagai warning non-blocking bila memang tidak ada skenario berguna yang bisa ditulis.

### 7.5 Metadata review internal [D]

| Field | Tipe | Aturan |
|---|---|---|
| `review_required` | boolean | Wajib. Tidak ada koersi (`"true"` bukan boolean). |
| `review_reason` | string \| null | Wajib tidak kosong bila `review_required = true`; `null` bila `false`. |
| `attention_area_ids` | string[] | Opsional; setiap ID harus ada di `understanding.json`. |

- Flag **hanya** berasal dari output terstruktur model. Tidak ada keyword matching, regex, atau heuristik linguistik pasca-generasi yang menyetel atau mengubah flag.
- Metadata menempel pada objek test case yang sama, jadi pemetaannya ke baris terjadi lewat identitas objek di sepanjang assembly, tidak lewat kecocokan teks.
- Field ini internal dan **tidak** menjadi kolom Excel.

Pelanggaran integritas, ditangani terstruktur tanpa menebak [D, U-2]:

| Kondisi | Penanganan |
|---|---|
| `review_required` tidak ada atau bukan boolean | Kasus tetap dipertahankan; `review_required = true`, `review_reason` diisi sistem `"[system] review metadata missing or invalid"`; warning `REVIEW_METADATA_INVALID`. Fail-safe ke arah review, bukan menebak isi. |
| `true` tanpa alasan | Sama, alasan sistem `"[system] review flagged without reason"`. |
| `false` dengan alasan tidak kosong | Flag model dipertahankan (`false`); warning `REVIEW_METADATA_INCONSISTENT`. |
| `attention_area_ids` berisi ID yang tidak dikenal | ID itu dibuang dari kasus; warning `UNKNOWN_ATTENTION_AREA`. |
| Deduplikasi menghapus kasus yang ditandai | Flag kasus yang bertahan = OR dari keduanya; alasan digabung. |

### 7.6 Pemrosesan deterministik Stage 2

Dipakai ulang dari modul yang bersih: `parseTestCases` (`generate/contract.js`), satu kasus rusak dibuang dan dilaporkan per posisi, sedangkan kasus lain tetap. Dari `generate/assemble.js`: penomoran `TC-nnn`, deduplikasi, dan penurunan `source_references` dari requirement/blok yang dikutip. Lalu `testCaseSchema` (`schema/testcase.js`), diperluas dengan tiga field §7.5.

[D] Contract envelope gagal total (bukan JSON, tidak ada `test_cases`) atau 0 kasus yang lolos → Stage 2 `failed`.

### 7.7 Artifact `testcases.json`

```jsonc
{
  "artifact": "testcases",
  "schema_version": "qai.p0.testcases/1",
  "run_id": "…",
  "inputs": { "understanding_sha256": "…", "extracted_prd_sha256": "…" },
  "test_cases": [ /* objek kanonik + review_required, review_reason, attention_area_ids */ ],
  "discarded": [ { "position": 4, "issues": [ "…" ] } ],
  "warnings": [ … ],
  "validation": { /* §12 */ }
}
```

Ditulis atomik dengan urutan yang sama seperti §6.1. Hanya ditulis bila Stage 2 sukses.

---

## 8. Penyimpanan run-scoped dan run metadata

### 8.1 Struktur [D]

```text
<QAI_STORAGE_DIR, default ./storage>/
└── runs/
    └── {run_id}/
        ├── source/
        │   └── <nama file asli yang disanitasi>
        ├── extracted_prd.json
        ├── understanding.json
        ├── testcases.json
        ├── testcases.xlsx
        └── run_metadata.json
```

- `run_id` = `crypto.randomUUID()` di server. Divalidasi dengan regex UUID sebelum dipakai sebagai path, untuk mencegah path traversal.
- Nama file sumber disanitasi dengan `sanitizeFilename` yang sudah ada [F `extract/detect.js`]; nama tidak pernah dipakai sebagai path di luar `source/`.
- `storage/` ditambahkan ke `.gitignore` (berisi PRD) saat implementasi.
- Satu run hanya punya satu stage yang berjalan: file kunci `run.lock` dibuat dengan flag eksklusif (`wx`). Kunci yang dimiliki instance server lain dianggap basi (§9.3).
- Tidak ada database atau workflow engine [D].

### 8.2 `run_metadata.json`

```jsonc
{
  "schema_version": "qai.p0.run_metadata/1",
  "run_id": "…",
  "created_at": "…", "updated_at": "…",
  "server_instance_id": "…",
  "source": { "documents": [ { "document_id": "DOC-001", "filename": "…", "sha256": "…", "size_bytes": 0 } ] },
  "data_classification": "INTERNAL",
  "pipeline": {
    "app_version": "1.0.0-m1",
    "stage1_prompt_sha256": "…", "stage2_prompt_sha256": "…",
    "provider": "Gemini", "model": "…"
  },
  "stages": {
    "extraction":    { "status": "succeeded", "started_at": "…", "finished_at": "…", "artifact": "extracted_prd.json", "artifact_sha256": "…", "error": null },
    "understanding": { "status": "succeeded", "attempts": 1, "artifact": "understanding.json", "artifact_sha256": "…", "usage": { "input_tokens": 0, "output_tokens": 0 }, "error": null },
    "generation":    { "status": "failed",    "attempts": 2, "artifact": null, "error": { "code": "LLM_TIMEOUT", "message": "…", "retryable": true },
                       "history": [ { "attempt": 1, "status": "failed", "error_code": "LLM_TIMEOUT", "finished_at": "…" } ] },
    "export":        { "status": "pending", "artifact": null }
  }
}
```

Status per stage: `pending | running | succeeded | failed` [D]. `prompt_sha256` mencatat hash instruksi sistem + schema yang dikirim, untuk reproduksibilitas. Kunci API dan isi dokumen tidak pernah ditulis ke metadata.

---

## 9. Kegagalan dan retry

### 9.1 Stage 1 gagal

Penyebabnya bisa error provider, JSON tidak valid, schema gagal, output terpotong, atau 0 requirement. Dalam semua kasus [D]:
- `stages.understanding.status = "failed"` dengan kode error; `understanding.json` tidak dibuat.
- Stage 2 tidak dimulai.
- Pengguna boleh menjalankan ulang Stage 1 secara eksplisit dengan run yang sama. Ekstraksi tidak diulang; `extracted_prd.json` dipakai lagi.

### 9.2 Stage 1 sukses, Stage 2 gagal [D]

- `understanding.json` dipertahankan. Stage 1 tidak dijalankan ulang otomatis.
- Retry Stage 2 lewat aksi pengguna: memuat ulang artifact dengan cek §6.2, lalu memanggil model sekali. `attempts` bertambah dan `history` mencatat percobaan sebelumnya.
- Tidak ada retry otomatis. Ini konsisten dengan prinsip blueprint "output salah bukan kasus retry" (§4.8) dan dengan pengalaman kuota bahwa request gagal pun memakai kuota.
- Error 429/503/timeout dicatat `retryable: true`. Output invalid dicatat `retryable: true`, tetapi tetap menunggu aksi pengguna.

### 9.3 Proses mati di tengah stage

Stage berstatus `running` dengan `server_instance_id` berbeda dari instance yang sedang berjalan dianggap terputus: ditandai `failed` dengan kode `INTERRUPTED`, `retryable: true`.

---

## 10. API dan frontend (minimal)

[D] Endpoint baru untuk jalur QAI. Endpoint lama (`/api/extract`, `/api/generate`, `/api/validate`, `/api/export`) tetap ada untuk QATOOL legacy sampai cut-over [U-7].

| Endpoint | Fungsi |
|---|---|
| `POST /api/runs` (multipart) | Membuat run, menyimpan sumber, lalu menjalankan ekstraksi → Stage 1 → Stage 2 di proses server. Langsung mengembalikan `run_id`. |
| `GET /api/runs/:run_id` | Membaca `run_metadata.json` plus ringkasan (empat field proyek, jumlah kasus dan kasus yang ditandai) untuk polling status. |
| `POST /api/runs/:run_id/stages/generation/retry` | Retry Stage 2 (§9.2). Ditolak bila Stage 1 belum sukses atau stage lain sedang berjalan. |
| `POST /api/runs/:run_id/stages/understanding/retry` | Menjalankan ulang Stage 1 setelah gagal. Ekstraksi tidak diulang. |
| `GET /api/runs/:run_id/export` | Membangun `testcases.xlsx` dari `testcases.json` yang dipersist, menyimpannya di run, lalu mengalirkannya ke browser. |

[D] Export dibaca dari artifact server, bukan dari canonical yang dikirim browser. Dengan begitu flag review dan isi kasus yang diekspor adalah persis hasil Stage 2 yang tersimpan.

Frontend [F → D]: alur Upload → Processing → Results → Download dipertahankan. Processing beralih ke polling `GET /api/runs/:id` menggantikan `runPipeline` tiga fase [F `web/src/pipeline.js`]. Results tetap menampilkan empat kartu field proyek [F `ResultsStage.jsx:236-262`]; hint "One sentence…" pada Project Description diganti. Daftar test case menampilkan penanda untuk kasus `review_required`. Tombol "Retry test case generation" muncul bila Stage 2 gagal. Tidak ada tombol approve.

---

## 11. Kontrak XLSX — format yang ada adalah kontrak tetap

### 11.1 Sumber kebenaran format [F]

Format ditentukan oleh **output exporter sekarang**, bukan oleh baris contoh di template:
- Header, dropdown, column widths, table, drawing, theme, dan styles berasal dari `templates/sit-script-template.xlsx` [F `template.js:62-111`].
- Style per sel data ditentukan `COLUMN_STYLES` [F `template.js:19-33`].
- Isi per kolom ditentukan `mapTestCaseToRow` [F `edge-case-mapping.js:182-194`].

[F] Baris contoh template memakai style yang berbeda (`C2 s=3`, `F2 s=4`), sedangkan exporter memakai `2`/`4` per kolom secara konsisten. Yang dikunci adalah **output exporter**.

| Kolom | Header (verbatim, termasuk typo) | Style sel data | Isi |
|---|---|---|---|
| A | Case ID | 2 (center) | `TC-nnn` |
| B | Section | 2 | `section` |
| C | Test Case | 4 (left) | `test_case` |
| D | Case Type | 2 | Positive/Negative; Edge diturunkan sesuai `edge_polarity` |
| E | Priority | 2 | `priority` |
| F | Type | 2 | `type` |
| G | Exected Result | 4 | `expected_result`; kasus Edge diberi prefix `[Edge Case] ` |
| H | Status | 2 | kosong |
| I | Tested By | 2 | kosong |

Lainnya [F]: satu worksheet `Sheet1`; data mulai baris 2; lebar kolom A=7.75, B=20.13, C=52.0, G=56.63, sisanya default 12.63; data validation D, E, H, I diarahkan ulang ke rentang data; `Table_1` (kolom C) diarahkan ulang; output byte-deterministik (mtime zip tetap); verifikasi baca-ulang `inspectWorkbook` setelah build. Aturan bahasa dan gaya penulisan test case berasal dari prompt generasi (§7.1).

[D] **Semua di atas tidak berubah.** Tidak ada kolom baru (QA Review, Review Required, Review Reason, Risk Level, Ambiguity, Confidence, atau metadata lain). Tidak ada perubahan bahasa, istilah, atau gaya penulisan.

### 11.2 Satu-satunya perubahan visual: highlight baris merah [D]

**Format XLSX yang ada + highlight baris merah bersyarat. Tidak ada yang lain berubah.**

Perilaku:
- Kasus `review_required = true` → sel **A sampai I** pada baris kasus itu mendapat fill solid merah muda. Kasus normal memakai style yang ada (`2`/`4`).
- [D, U-3] "Seluruh baris" = sembilan kolom test case (A–I). Tidak memakai style level-`<row>`, yang akan mewarnai kolom J dan seterusnya di luar format.
- Warna: `FFFFC7CE`, fill "Light Red" bawaan Excel, sehingga teks hitam tetap terbaca. [U-4]

Mekanisme, dengan perubahan sesempit mungkin pada exporter:
1. Bila **tidak ada** baris yang ditandai, `styles.xml` disalin byte-per-byte seperti sekarang. Workbook identik dengan output hari ini.
2. Bila ada baris yang ditandai, `styles.xml` dibangun ulang dari salinan template dengan hanya **menambahkan di akhir**: satu `<fill>` solid `FFFFC7CE` (indeks = jumlah fill lama), dan dua `<xf>` yang merupakan klon persis atribut dan alignment `cellXfs[2]` dan `cellXfs[4]` dengan `fillId` baru dan `applyFill="1"`. Atribut `count` diperbarui. Entri yang sudah ada tidak diubah atau diurutkan ulang.
3. `buildRow` memakai varian merah dari style kolomnya untuk baris yang ditandai. Sel kosong (H, I) juga ditulis dengan style merah, seperti sekarang sel kosong tetap ditulis dengan style kolomnya [F `sheet-builder.js` `cell()`].
4. Fill sel langsung menimpa banding table style di kolom C, sehingga highlight terlihat konsisten di seluruh baris. [A] Perilaku standar Excel; diverifikasi manual sekali dengan membuka file.
5. `inspectWorkbook` diperluas: baris yang ditandai harus memakai xf merah di A–I, baris lain harus memakai `2`/`4`.

Pemetaan flag ke baris: `mapTestCaseToRow` meneruskan `review_required` dari objek test case yang sama; urutan baris tetap ditentukan `order_index`/`case_id` [F `sit-script-export.js`]. Tidak ada pencocokan teks.

### 11.3 Tes regresi kompatibilitas Excel (wajib saat implementasi)

1. Header baris 1 identik dengan template (9 label, urutan sama, termasuk `Exected Result`).
2. Jumlah kolom tetap 9; tidak ada sel di kolom J ke kanan.
3. Worksheet tetap satu, `Sheet1`; daftar part zip identik dengan template.
4. Isi sel per kolom identik dengan exporter lama untuk input yang sama (fixture `export/fixtures/sample-test-cases.js`).
5. Tanpa baris ditandai: output **byte-identik** dengan exporter lama.
6. Dengan baris ditandai: semua part selain `sheet1.xml`, `sharedStrings.xml`, `table1.xml`, `styles.xml` tetap byte-identik; `styles.xml` lama adalah prefix-preserved (fill dan xf lama tidak berubah, hanya ada tambahan di akhir).
7. Baris ditandai: A–I memakai xf merah dengan fill `FFFFC7CE`; baris normal memakai `2`/`4` tanpa fill.
8. Lebar kolom, data validation (formula verbatim), dan rentang table tetap mengikuti aturan yang ada.
9. Tes yang ada di `server/export/sit-script-export.test.js` tetap lulus tanpa melemahkan asersinya. Tes "byte-for-byte" disesuaikan hanya untuk kasus dengan baris yang ditandai.

---

## 12. Validasi deterministik minimal

[D] Fokus pada kebenaran teknis.

| Cek | Blocking? |
|---|---|
| Output Stage 1/2 sesuai schema | Ya: stage gagal |
| Field wajib test case ada (`test_case`, `expected_result`, `section`, `case_type`) | Kasus rusak dibuang per kasus dan dilaporkan; stage gagal bila 0 kasus lolos |
| `requirement_ids` menunjuk requirement di `understanding.json`; `source_block_ids` ada di `extracted_prd.json` | ID yang tidak dikenal dibuang + warning; kasus tanpa referensi sah sama sekali → warning `UNTRACED_TEST_CASE` [U-1] |
| Metadata review terpetakan ke kasusnya (§7.5) | Tidak (fail-safe ke review) |
| Artifact milik run yang benar (§6.2) | Ya: stage tidak jalan |
| Export: `checkExportable` yang ada (expected result / test case kosong) [F] | Ya: seperti sekarang |
| Workbook bisa dibaca ulang (`inspectWorkbook`) | Ya: seperti sekarang |
| Ringkasan traceability tingkat requirement (requirement mana yang dikutip ≥1 kasus) | Tidak. Hanya informasi, diberi label "traceability, bukan coverage perilaku" |

Yang **tidak** menjadi blocking gate: kelengkapan edge case, klaim coverage dari AI, ambiguitas yang belum terselesaikan, jumlah test case, maupun persetujuan reviewer.

[D] Ringkasan traceability QAI dihitung oleh fungsi kecil baru yang tidak mengimpor `canonical.js`. `buildCoverage` menghitung obligation di dalamnya [F `schema/canonical.js:148`].

[D] Diagnostik heuristik (`semantic/heuristics.js`, `semantic/testcase-diagnostics.js`) tidak masuk jalur P0 default dan tidak pernah menyetel `review_required`. Tetap tersedia di legacy.

---

## 13. Obligation engine: dihapus dari target QAI

### 13.1 Keputusan [D]

Derivasi obligation **bukan bagian dari arsitektur target QAI P0**. Alasannya: bergantung pada pola linguistik dan kata kunci hardcoded, bahasa PRD bervariasi antar penulis dan tim, berisiko overfit ke gaya dokumen yang terbatas, dan tidak dibutuhkan alur QA yang disepakati.

QAI tidak bergantung pada: derivasi obligation sebagai prasyarat generasi, `obligation_plan` sebagai kontrak output, coverage berbasis obligation sebagai klaim kelengkapan perilaku, gap obligation sebagai input reviewer, maupun pola hardcoded sebagai definisi utama apa yang harus dites.

[D] **Perluasan yang konsisten dengan keputusan ini:** `scenario/checklist.js` (checklist skenario berbasis pola, sumber primitif obligation) juga tidak dipakai di jalur QAI, karena alasannya sama. Ini tafsiran saya atas §7 tugas refinement; konfirmasi di [U-7].

Yang dipertahankan: traceability tingkat requirement, source reference yang bisa diverifikasi, validasi struktural dasar, dan konvensi export.

[D] Traceability tingkat requirement **tidak** boleh dipresentasikan sebagai bukti bahwa setiap perilaku, cabang, atau kondisi sudah dites.

### 13.2 Penegakan

[D] Tes graf import: mulai dari modul entry QAI (`server/qai/**`), telusuri `import` relatif secara transitif. Tes gagal bila `server/scenario/obligations.js` atau `server/scenario/checklist.js` terjangkau. Ini memakai teknik yang sama dengan analisis di §2.1.

### 13.3 Konsumen legacy dan risiko migrasi [F]

| Konsumen | Pemakaian | Status di QAI | Legacy |
|---|---|---|---|
| `schema/canonical.js:148` `buildCoverage` | coverage obligation di `/api/validate` | Tidak dipakai; diganti ringkasan traceability §12 | Tetap |
| `generate/index.js`, `generate/prompt.js`, `generate/claims.js` | daftar obligation di prompt, enum `obligation_plan`, audit klaim, metadata coverage | Tidak dipakai; prompt Stage 2 baru | Tetap |
| `structure/recover.js` (via `structure/index.js`, `extract/index.js`) | memulihkan blok perilaku yang disisihkan #1 | Tidak dipakai; digantikan input PRD penuh ke Stage 2 | Tetap |
| `semantic/index.js` `reviewableGaps` | gap untuk reviewer LLM #3 | Reviewer tidak ada di P0 | Tetap |
| `web/src/stages/ResultsStage.jsx` | menampilkan `coverage.obligations` (sebagian/penuh) | Tidak ada di respons QAI | Tetap untuk UI legacy |
| `server/benchmark/compare.js` | **tidak** memakai matcher (sengaja independen) | Oracle tetap bisa dipakai untuk evaluasi offline | Tetap |
| 29 file tes menyebut obligation; 17 file tes `server/scenario/` (5.844 baris) | kalibrasi detector | Tidak relevan | Tetap |

Risiko:
- **Hilangnya recovery:** di benchmark V1, discovery oracle Settlement sama untuk keenam trial karena recovery [R `model-benchmark/REPORT.md`]. Tanpanya, kualitas grouping Stage 1 langsung memengaruhi kasus mana yang punya `requirement_ids`. Mitigasinya: Stage 2 tetap membaca seluruh PRD, plus [U-1].
- **Kehilangan sinyal "coverage sebagian"** yang sekarang ditampilkan di Results. Ini disengaja; jangan diganti dengan klaim baru.
- **Penghapusan kode** (`obligations.js`, `checklist.js`, `recover.js`, `claims.js`, tes kalibrasi) **tidak** dilakukan di P0. Itu migrasi terpisah setelah UI dan endpoint legacy dipensiunkan [U-7].

---

## 14. Keputusan komponen

| Komponen | Keputusan P0 | Catatan |
|---|---|---|
| Document extraction | **Keep** | Parser dipanggil langsung (§4) |
| Strukturisasi requirement #1 / pemahaman PRD | **Merge** ke Stage 1 | Kontrak grouping dipakai ulang |
| Project Description, QA Guidance, SIT Scope, Project Background | **Stage 1** | Pindah dari #2; batas 300 karakter dan aturan satu kalimat tidak berlaku |
| Context understanding dan attention areas | **Stage 1** | Baru |
| PRD Reviewer LLM terpisah | **Remove** dari alur wajib | — |
| Test Plan Generator | **Defer** | — |
| Test Intent Generator | **Tidak dibuat** | Konsepnya terwakili oleh attention area + `test_points` di Stage 1 |
| Testcase generation | **Stage 2** | Prompt baru; konvensi penulisan dibawa |
| Test Case Reviewer wajib (#3) | **Remove** dari alur wajib | Legacy opt-in tetap |
| Ketergantungan obligation engine | **Remove** dari target QAI | §13 |
| Checklist skenario | **Remove** dari target QAI | §13.1, [U-7] |
| Fallback deterministik #1 | **Remove** dari jalur QAI | [U-9] |
| Validasi deterministik dasar | **Keep** | §12 |
| Traceability requirement | **Keep** | Bukan klaim coverage |
| Persistensi artifact Stage 1 | **Keep** (baru) | §6 |
| Penyimpanan run berbasis file | **Keep** (baru, minimal) | §8 |
| Exporter XLSX | **Keep**, diperluas hanya untuk highlight | §11 |
| Gerbang approval sebelum output | **Remove** | — |
| Review manual QA setelah output | **Keep** | Titik keputusan manusia utama |
| Diagnostik/heuristik semantik | **Defer** di jalur QAI | Legacy tetap |
| Provider abstraction | **Keep** | Tidak diubah (§15) |

---

## 15. Prinsip blueprint yang dipertahankan

| Prinsip (Blueprint v4) | Bentuk di P0 |
|---|---|
| Traceability berbasis sumber (§2.9) | Requirement verbatim dari blok; source reference diturunkan kode; ID blok/AA/REQ divalidasi; tidak ada sitasi karangan |
| AI untuk reasoning, sistem untuk kebenaran (§2.1) | ID, teks requirement, source reference, validasi, status, export ditentukan kode |
| Validasi schema output (§7.3) | Zod strict per stage; output gagal schema tidak dipersist |
| Konten eksternal adalah data (§10.5) | Pembungkus untrusted-content di prompt Stage 1 dan 2 |
| Klasifikasi data (§10.2) | `data_classification` dicatat di run (default INTERNAL); panggilan provider ditolak untuk CONFIDENTIAL/RESTRICTED [U-6] |
| Versioning, audit, reproduksibilitas (§6.7, §10.6) | SHA-256 sumber dan artifact, hash prompt, model, versi app, riwayat attempt di `run_metadata.json` |
| Manusia memegang keputusan akhir (§11.6) | Review manual di Excel |
| Provider abstraction (§5.3, ADR-010) | Interface `generateJson` tetap; prompt bebas vendor; adapter Anthropic kelak cukup file baru di `server/llm/` |

Yang tidak diubah oleh refinement ini [D]: stack teknologi, model autentikasi (tidak ada auth di QATOOL sekarang), deployment, dan provider abstraction.

---

## 16. Keputusan lama yang di-supersede

| Keputusan lama | Sumber | Status |
|---|---|---|
| Server stateless, tidak ada tulis ke disk, tidak ada store abstraction | `docs/IMPLEMENTATION.md` §1, `server/no-persistence.test.js`, keputusan V1 | **Superseded** untuk jalur QAI: penyimpanan run berbasis file. `no-persistence.test.js` diganti dengan aturan sempit: hanya `server/qai/store` yang boleh menulis, hanya di bawah `QAI_STORAGE_DIR` |
| Tidak ada gerbang approval; review di Excel | `docs/IMPLEMENTATION.md`, `ResultsStage.jsx:30-34` | **Tetap** (dikonfirmasi) |
| 3 panggilan LLM (#1, #2, #3 opt-in) | `docs/IMPLEMENTATION.md` | **Superseded**: 2 panggilan |
| Input #2 hanya requirement, bukan teks dokumen | `generate/prompt.js:9-18` | **Superseded**: Stage 2 menerima PRD hasil ekstraksi |
| "Never guess": kasus tidak didukung diganti `INSUFFICIENT_INFORMATION` | `generate/prompt.js:32,42,84` | **Superseded**: generate + flag (§7.4); larangan fakta karangan tetap |
| `project_description` satu kalimat ≤300 karakter | `schema/project.js`, benchmark V2 (2026-10-29) | **Superseded** untuk QAI: tanpa batas, komprehensif |
| Fallback fail-soft #1 | `structure/index.js` | **Superseded** untuk QAI (§5.3) |
| Obligation, `obligation_plan`, claim audit, recovery, gap reviewer | `scenario/obligations.js` dan konsumennya | **Removed** dari target QAI (§13) |
| Penilaian arsitektur 2026-10-31 (5 panggilan, 3 gerbang, keep obligation) | `scratchpad/qai-migration/ARCHITECTURE_ASSESSMENT.md` | **Superseded seluruhnya** |
| Blueprint §2.4/§7.2 reviewer asimetris wajib | Blueprint v4 | **Deviasi P0**: tidak ada di alur wajib |
| Blueprint §2.10, §6.8 gerbang manusia (approve review, plan, test case) dan state machine project | Blueprint v4 | **Deviasi P0**: diganti status per stage + review manual setelah output |
| Blueprint §4.5 capability `requirement_intake`, `prd_reviewer`, `test_plan_generator`, `test_case_reviewer` | Blueprint v4 | **Deviasi P0**: merge/defer/remove (§14) |
| Blueprint §4.7 Definition of Ready dan readiness gate | Blueprint v4 | **Deviasi P0**: bukan gate; ambiguitas muncul sebagai attention area |
| Blueprint §6.2 entitas `test_intent`, `test_plan` | Blueprint v4 | **Deviasi P0**: tidak dibuat |
| Blueprint §6.5 tabel citation dengan verifikasi `quoted_text` | Blueprint v4 | **Sebagian**: model tidak menulis kutipan; referensi berupa ID blok yang divalidasi, kutipan diambil sistem dari blok |
| Blueprint §7.4/§7.5 Criteria Registry dan convergence rule | Blueprint v4 | **Defer** |
| Blueprint §3.4, §4.3, §13.2 Postgres schema `qai` | Blueprint v4 | **Deviasi P0**: file store run-scoped. Migrasi kelak: artifact JSON memetakan ke tabel run/artifact; `run_metadata` ke `agent_run`/`step_run` |
| Blueprint §5.2 FastAPI/Next.js | Blueprint v4 | **Deviasi P0**: stack Node tetap |
| Blueprint §9.4b namespace `QAI-TC-<squad>-<nnnn>` | Blueprint v4 | **Defer**: `TC-nnn` tetap (kontrak Excel) |
| Blueprint §10.4 guardrail tier 1 (scan PII/secret) | Blueprint v4 | **Defer**, dicatat sebagai deviasi [U-6] |
| Blueprint §3.3 gate Phase 0A (capability spike sebelum platform) | Blueprint v4 | **Belum dipenuhi** [U-5] |

---

## 17. Lingkup dan kriteria penerimaan P0

**Workflow**
- Alur normal memakai tepat dua panggilan LLM (dihitung di tes dengan provider mock).
- Stage 1 menghasilkan keempat field proyek, context, dan attention area.
- Stage 2 memakai `extracted_prd.json` dan `understanding.json`.
- Tidak ada gerbang approval sebelum output.

**Persistensi**
- Setiap run punya `run_id` dan direktori sendiri.
- `understanding.json` divalidasi lalu ditulis atomik sebelum Stage 2 mulai. Tes: provider Stage 2 tidak dipanggil sebelum file dan metadata ada.
- Stage 2 membaca dari disk. Tes: memodifikasi `understanding.json` setelah Stage 1 → Stage 2 gagal `ARTIFACT_INTEGRITY` tanpa memanggil model.
- Stage 2 gagal → `understanding.json` tetap; retry tidak memanggil Stage 1 (hitung panggilan provider).
- Artifact dari run lain atau dari dokumen lain ditolak.
- Tidak ada database atau workflow engine.

**Generasi test case**
- Kontrak mendukung Positive/Negative/Edge dan `edge_polarity` seperti sekarang.
- Kasus berbasis asumsi tetap dihasilkan dan ditandai, tidak ditulis sebagai fakta (diverifikasi di evaluasi PRD nyata, §18 langkah 10).
- Traceability `requirement_ids`/`source_references` tetap utuh.

**Excel** — seluruh §11.3.

**Arsitektur**
- Tes graf import (§13.2) lulus: jalur QAI tidak menjangkau `obligations.js` maupun `checklist.js`.
- Konsumen legacy terdokumentasi (§13.3).
- Validasi hanya teknis (§12).
- Tidak ada PRD Reviewer, Test Plan Generator, Test Intent Generator, atau Test Case Reviewer di alur default.
- Suite tes yang ada tetap lulus (baseline 1227 tes, 1216 lulus, 0 gagal), kecuali `no-persistence.test.js` yang diganti secara sadar (§16).

[D] Lulus kriteria ini berarti **workflow berjalan**, bukan **kualitas reasoning tervalidasi**.

---

## 18. Dependensi dan urutan implementasi

| # | Langkah | Bergantung pada | Modul |
|---|---|---|---|
| 0 | Batas modul QAI + tes graf import | — | `server/qai/`, tes baru |
| 1 | Schema output Stage 1 (Zod + JSON Schema) | 0 | `server/qai/understanding/contract.js` (memakai ulang `structure/contract.js`) |
| 2 | Prompt Stage 1 dan pembentukan input dari blok | 1 | `server/qai/understanding/prompt.js` (memakai ulang `buildStructurePrompt` atau bagiannya) |
| 3 | Store run + tulis atomik + `run_metadata` + lock | 0 | `server/qai/store.js`, `config.js` (`QAI_STORAGE_DIR`), `.gitignore` |
| 4 | Loader artifact dengan cek integritas; kontrak input Stage 2 | 1, 3 | `server/qai/artifacts.js` |
| 5 | Prompt + kontrak Stage 2 dengan metadata review | 4 | `server/qai/generation/{prompt,contract}.js` (memakai ulang `parseTestCases`, `assemble.js`, `schema/testcase.js` yang diperluas) |
| 6 | Persist `testcases.json` | 3, 5 | `server/qai/generation/index.js` |
| 7 | Validasi minimal dan traceability | 6 | `server/qai/validate.js` |
| 8 | Highlight baris di exporter | — (paralel) | `server/export/{template,sheet-builder,sit-script-export,edge-case-mapping,inspect}.js` |
| 9 | Route `/api/runs*` dan perubahan frontend; tes handoff, retry, kompatibilitas Excel | 3–8 | `server/routes/runs.js`, `web/src/{pipeline,api}.js`, `ResultsStage.jsx` |
| 10 | Verifikasi end-to-end pada PRD nyata yang representatif (kedua PRD sanitized), termasuk review manual kasus yang ditandai | 9 | — |

---

## 19. Risiko, trade-off, keputusan terbuka

**Trade-off yang diterima** [D]
- Satu panggilan Stage 1 kini memikul grouping **dan** pemahaman. Output lebih besar, sehingga risiko timeout/truncation naik. Diterima demi aturan dua panggilan.
- Tanpa reviewer dan obligation, tidak ada pengaman otomatis atas kelengkapan atau kontradiksi. Pengamannya adalah review manual QA plus flag dari model. Benchmark V1 menemukan kontradiksi status pada Gemini Flash-Lite [R]; di P0, temuan seperti itu hanya tertangkap oleh QA.
- File store tidak memberi transaksi atau query; cukup untuk satu pengguna dan satu proses.

**Keputusan terbuka yang butuh owner**

| # | Isu | Rekomendasi |
|---|---|---|
| U-1 | Traceability untuk kasus dari blok yang tidak masuk requirement mana pun | Izinkan `source_block_ids` sebagai referensi sah; `requirement_ids` boleh kosong bila blok sumber valid, disertai warning `UNTRACED_TEST_CASE` bila keduanya kosong. Excel tidak terdampak (tidak ada kolom requirement). |
| U-2 | Metadata review invalid | Fail-safe: ditandai merah dengan alasan sistem (§7.5), bukan dibuang |
| U-3 | Cakupan highlight | Kolom A–I, bukan seluruh baris worksheet |
| U-4 | Warna | `FFFFC7CE` |
| U-5 | Gate kualitas: Phase 0A belum dipenuhi; pemilihan model Gemini. Flash-Lite punya kelemahan terukur di V1; `gemini-3.8-flash` timeout 2/2 pada 120 s di V2; blueprint menetapkan 180 s untuk AI_TASK | Putuskan model dan `LLM_TIMEOUT_MS` sebelum langkah 10; ukur 2 PRD × 3 run |
| U-6 | Penyimpanan PRD asli di disk (sebelumnya sengaja tidak pernah); retensi, pembersihan, dan akses `storage/`; penegakan klasifikasi; guardrail tier 1 ditunda; syarat Google untuk layanan tanpa bayar | Retensi eksplisit (mis. hapus setelah N hari) dan klasifikasi minimal di P0 |
| U-7 | Cut-over UI/endpoint legacy; penghapusan obligation/checklist/recover lewat migrasi terpisah; konfirmasi checklist ikut dikeluarkan | Coexist sampai P0 lulus langkah 10, lalu migrasi penghapusan terpisah |
| U-8 | `temperature`: blueprint meminta 0, sedangkan konfigurasi sekarang mengikuti default Gemini 3 [F `config.js:66-71`] | Tetap konfigurasi sekarang; ukur konsistensi |
| U-9 | Mode degradasi deterministik bila Stage 1 gagal | Tidak di P0; retry Stage 1 manual |
| U-10 | Pensiun `confidence` di kontrak QAI | Ya; `review_required` adalah satu-satunya sinyal review |
| U-11 | Ambiguitas bisnis yang sudah diketahui (retry NOT FOUND, "immediately", REQ-053) | Tidak diselesaikan di arsitektur. Di P0 muncul sebagai attention area dan kasus bertanda merah untuk diputuskan SME/QA |
| U-12 | Persetujuan deviasi P0 (§16) oleh pemilik Blueprint v4 | Diperlukan sebelum implementasi |
