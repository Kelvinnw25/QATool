/**
 * Synthetic PRD/RFC fixtures for quality evaluation.
 *
 * Every word here is invented. No Bank Sinarmas document, or any part of one,
 * may be added to this file: with a real provider configured these documents
 * are sent to that provider, and the trial runs on Gemini's unpaid tier, whose
 * terms forbid confidential material.
 *
 * The sets are grouped so that one generation call exercises two or three of
 * the scenarios under evaluation. Each set is deliberately small: the point is
 * to judge the quality of what comes back, not to measure throughput.
 *
 * Each fixture also carries `expectations` - what a competent QA engineer
 * should produce from these documents. Nothing reads them programmatically to
 * pass or fail a run; they are the yardstick the evaluation report is written
 * against, recorded up front so the assessment is not retrofitted to whatever
 * the model happened to do.
 */
import { buildDocx, buildPdf } from '../../server/extract/fixtures/build.js';

/* ----------------------------------------------------------------- A ----- */

const loginPortal = {
  id: 'A',
  name: 'Customer Portal Login (synthetic)',
  scenarios: [
    'simple functional requirement',
    'positive + negative behavior',
    'ambiguous / insufficient information',
    'English requirements',
  ],
  expectations: [
    'A positive case for a successful login with valid credentials.',
    'A negative case for a wrong password, asserting the failed-attempt counter.',
    'A negative or edge case for the third consecutive failure locking the account for 30 minutes.',
    'The two vague requirements (responsive/user-friendly, adequate performance) should be refused as INSUFFICIENT INFORMATION rather than invented into timing assertions.',
  ],
  documents: [
    {
      filename: 'PRD Customer Portal Login (synthetic).docx',
      build: () =>
        buildDocx([
          { heading: 'Customer Portal - Authentication', level: 1 },
          {
            text: 'A registered customer must be able to sign in to the portal using a registered email address and password.',
          },
          {
            text: 'On a successful sign in the system must display the account dashboard showing the customer name and the last login timestamp.',
          },
          { heading: 'Failed Authentication', level: 2 },
          {
            text: 'If the password does not match the stored credential, the system must reject the sign in and increment the failed attempt counter for that account.',
          },
          {
            text: 'After three consecutive failed attempts the account must be locked for 30 minutes and no further sign in attempt may be accepted during that period.',
          },
          { heading: 'Non Functional Notes', level: 2 },
          {
            text: 'The portal should be responsive and user-friendly on all supported devices.',
          },
          {
            text: 'Performance of the login page must be adequate under normal load conditions.',
          },
        ]),
    },
  ],
};

/* ----------------------------------------------------------------- B ----- */

const transferLimits = {
  id: 'B',
  name: 'Fund Transfer Limits (synthetic)',
  scenarios: [
    'boundary / edge cases',
    'requirement with multiple related conditions',
    'English requirements',
  ],
  expectations: [
    'Edge cases at 10,000 and 50,000,000 with edge_polarity=valid (both bounds are inclusive).',
    'Edge cases at 9,999 and 50,000,001 with edge_polarity=invalid.',
    'Coverage of the four-condition rule: at minimum one case where all conditions hold, and one per condition that fails.',
    'An edge case at exactly 100,000,000 cumulative daily (valid) and just above it (invalid).',
    'No invented error codes - this document states none.',
  ],
  documents: [
    {
      filename: 'PRD Fund Transfer Limits (synthetic).docx',
      build: () =>
        buildDocx([
          { heading: 'Transfer Amount Limits', level: 1 },
          {
            text: 'A single fund transfer must be at least IDR 10,000 and at most IDR 50,000,000. Both limits are inclusive.',
          },
          {
            text: 'A transfer amount outside the permitted range must be rejected before the transfer is submitted.',
          },
          { heading: 'Eligibility Conditions', level: 2 },
          {
            text: 'A fund transfer may only be submitted when all of the following conditions are met: the source account status is Active, the available balance is greater than or equal to the transfer amount, the cumulative transfer amount for the calendar day does not exceed IDR 100,000,000, and the destination account is not on the blacklist.',
          },
          {
            text: 'If any one of the eligibility conditions is not met, the transfer must be rejected and the reason must be shown to the customer.',
          },
        ]),
    },
  ],
};

/* ----------------------------------------------------------------- C ----- */

const participantStatus = {
  id: 'C',
  name: 'Status Peserta Kliring (synthetic)',
  scenarios: ['table-heavy requirement', 'Indonesian requirements'],
  expectations: [
    'One case per participant status in the table (Aktif, Suspended, Ditutup), each asserting the stated action.',
    'Validation cases for the mandatory fields in the second table, including the 16-digit account number length.',
    'Test cases should stay in the document language or be consistently phrased; no invented error codes beyond KLR-01 / KLR-02.',
    'The 16-digit rule is a boundary: 15 and 17 digits are reasonable Edge/invalid cases.',
  ],
  documents: [
    {
      filename: 'PRD Status Peserta Kliring (synthetic).docx',
      build: () =>
        buildDocx([
          { heading: 'Ketentuan Status Peserta', level: 1 },
          {
            text: 'Sistem harus memeriksa status peserta sebelum instruksi kliring diteruskan ke penyelenggara.',
          },
          {
            table: [
              ['Status Peserta', 'Aksi Sistem', 'Kode'],
              ['Aktif', 'Instruksi diteruskan ke penyelenggara', '-'],
              ['Suspended', 'Instruksi ditolak dan dicatat pada log penolakan', 'KLR-01'],
              ['Ditutup', 'Instruksi ditolak dan peserta tidak dapat dipilih', 'KLR-02'],
            ],
          },
          { heading: 'Validasi Field Instruksi', level: 2 },
          {
            table: [
              ['Nama Field', 'Ketentuan', 'Wajib'],
              ['Nomor Rekening Tujuan', 'Harus 16 digit angka', 'Ya'],
              ['Nama Penerima', 'Maksimal 70 karakter', 'Ya'],
              ['Berita Transfer', 'Maksimal 140 karakter', 'Tidak'],
            ],
          },
          {
            text: 'Instruksi dengan field wajib yang kosong harus ditolak dan tidak disimpan ke dalam antrian kliring.',
          },
        ]),
    },
  ],
};

/* ----------------------------------------------------------------- D ----- */

const paymentApi = {
  id: 'D',
  name: 'Payment API (synthetic)',
  scenarios: [
    'API / error-code behavior explicitly documented',
    'positive + negative behavior',
    'English requirements',
  ],
  expectations: [
    'A positive case for 201 with a paymentId in the response body.',
    'One negative case per documented error: ERR_INVALID_AMOUNT (400), ERR_DUPLICATE_REFERENCE (409), ERR_ACCOUNT_BLOCKED (422).',
    'A case for the 30-second timeout returning 504 ERR_UPSTREAM_TIMEOUT.',
    'Codes and statuses must be quoted exactly as documented. Any other code or status is a hallucination.',
  ],
  documents: [
    {
      filename: 'RFC Payment API (synthetic).pdf',
      build: () =>
        buildPdf([
          [
            'Payment Submission API',
            'The endpoint POST /api/v1/payments must accept a payment instruction',
            'containing reference, amount and destinationAccount.',
            'On success the API must return HTTP 201 with a paymentId in the response body.',
            'If the amount is zero or negative the API must return HTTP 400 with the error',
            'code ERR_INVALID_AMOUNT.',
          ],
          [
            'Error Responses',
            'If the reference has already been used the API must return HTTP 409 with the',
            'error code ERR_DUPLICATE_REFERENCE and must not create a second payment.',
            'If the destination account is blocked the API must return HTTP 422 with the',
            'error code ERR_ACCOUNT_BLOCKED.',
            'If the core banking system does not respond within 30 seconds the API must',
            'return HTTP 504 with the error code ERR_UPSTREAM_TIMEOUT.',
          ],
        ]),
    },
  ],
};

/* ----------------------------------------------------------------- E ----- */

const otpConflict = {
  id: 'E',
  name: 'OTP Verification (synthetic)',
  scenarios: ['conflicting requirements across documents', 'English requirements'],
  expectations: [
    'The lifetime conflict (120s vs 300s) and the attempt conflict (3 vs 5) must both be surfaced.',
    'The model must not silently pick one side, and must not average or invent a third value.',
    'Confidence on any case that depends on a conflicted value should be reduced, or the case should state the conflict.',
    'The resend cooldown (60s) is stated in only one document and is safe to test.',
  ],
  documents: [
    {
      filename: 'PRD OTP Verification (synthetic).docx',
      build: () =>
        buildDocx([
          { heading: 'OTP Verification', level: 1 },
          {
            text: 'The system must send a 6 digit OTP to the registered mobile number when the customer submits a transaction above IDR 1,000,000.',
          },
          {
            text: 'An OTP must remain valid for 120 seconds from the time it is sent. An expired OTP must be rejected.',
          },
          {
            text: 'The customer must be allowed a maximum of 3 OTP verification attempts per transaction.',
          },
        ]),
    },
    {
      filename: 'RFC OTP Service (synthetic).pdf',
      build: () =>
        buildPdf([
          [
            'OTP Service Parameters',
            'An OTP must remain valid for 300 seconds from the time it is generated.',
            'The service must allow a maximum of 5 verification attempts before the',
            'transaction is cancelled.',
            'A customer must wait at least 60 seconds before requesting a new OTP.',
          ],
        ]),
    },
  ],
};

export const FIXTURE_SETS = [
  loginPortal,
  transferLimits,
  participantStatus,
  paymentApi,
  otpConflict,
];

/** Builds the multipart body for one set. Buffers are created per call. */
export function uploadFor(set) {
  const form = new FormData();
  for (const document of set.documents) {
    form.append('documents', new Blob([document.build()]), document.filename);
  }
  return form;
}
