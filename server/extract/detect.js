import { AppError } from '../lib/errors.js';
import { looksLikeTranscription } from './parsers/transcription.js';
import { safeUnzip } from './zip.js';

/**
 * Identifies an uploaded file from its bytes, not its name.
 *
 * A filename is user-supplied and can be wrong or hostile; the magic bytes
 * cannot. DOCX and XLSX are both ZIP containers, so they are told apart by
 * which part directory they carry.
 */

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // %PDF

export const SUPPORTED_TYPES = ['pdf', 'docx', 'xlsx', 'transcription'];

function startsWith(bytes, magic) {
  return magic.every((byte, index) => bytes[index] === byte);
}

/**
 * Filenames arrive from the browser and are kept as metadata only. Path
 * separators and control characters are stripped so a name can never be used
 * to reach outside anything - even though nothing is written to disk.
 */
export function sanitizeFilename(filename) {
  const base = String(filename ?? '')
    .split(/[/\\]/)
    .pop();

  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001F<>:"|?*]/g, '').trim();
  return cleaned.slice(0, 255) || 'document';
}

/**
 * @returns {'pdf'|'docx'|'xlsx'}
 * @throws {AppError} UNSUPPORTED_FILE_TYPE / CORRUPT_DOCUMENT
 */
export function detectFileType(buffer, filename) {
  const name = sanitizeFilename(filename);

  if (buffer.length === 0) {
    throw new AppError('EMPTY_DOCUMENT', `'${name}' is empty.`, 422);
  }

  if (startsWith(buffer, PDF_MAGIC)) return 'pdf';

  // A QATOOL image transcription: JSON carrying the marker. Checked before the
  // ZIP branch and recognised by content rather than by name, like everything
  // else here. It is the one upload whose text a human wrote rather than a
  // document, which is why it is a type of its own and not a .txt.
  if (looksLikeTranscription(buffer)) return 'transcription';

  if (!startsWith(buffer, ZIP_MAGIC)) {
    throw new AppError(
      'UNSUPPORTED_FILE_TYPE',
      `'${name}' is not a PDF, DOCX, XLSX or QATOOL transcription file.`,
      415
    );
  }

  let parts;
  try {
    // Bounded: an archive that expands past the limits is refused, not inflated.
    parts = safeUnzip(new Uint8Array(buffer));
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw new AppError(
      'CORRUPT_DOCUMENT',
      `'${name}' looks like an Office file but could not be opened. It may be corrupt.`,
      422
    );
  }

  const names = Object.keys(parts);
  if (names.some((part) => part.startsWith('word/'))) return 'docx';
  if (names.some((part) => part.startsWith('xl/'))) return 'xlsx';

  throw new AppError(
    'UNSUPPORTED_FILE_TYPE',
    `'${name}' is a ZIP archive but not a Word or Excel document.`,
    415
  );
}

/**
 * Classifies a document for the canonical model from its filename. A guess, and
 * treated as one - it steers nothing except display.
 */
export function guessDocumentType(filename) {
  const name = sanitizeFilename(filename).toLowerCase();

  if (/\brfc\b|request\s*for\s*change/.test(name)) return 'RFC';
  if (/\bprd\b|product\s*requirement/.test(name)) return 'PRD';
  if (/\bapi\b|postman|swagger|openapi/.test(name)) return 'API Specification';
  if (/tech|spec|design|hld|lld/.test(name)) return 'Technical Specification';
  return 'Supporting Document';
}
