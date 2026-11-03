import { AppError } from '../lib/errors.js';
import { formatSequentialId, ID_PREFIX } from '../lib/ids.js';
import { detectFileType, guessDocumentType, sanitizeFilename } from './detect.js';
import { parsePdf } from './parsers/pdf.js';
import { parseDocx } from './parsers/docx.js';
import { parseXlsx } from './parsers/xlsx.js';
import { parseTranscription } from './parsers/transcription.js';
import { trace, setStage } from '../lib/trace.js';

/**
 * Half one of extraction: reading the documents. Deterministic, no model, no network.
 *
 * Lives apart from the structuring call (extract/index.js) so that a worker thread can
 * load it without loading the model code, and so that the public demo can run it in
 * isolation (extract/isolated.js).
 */

/**
 * Below this many characters a document is treated as suspiciously empty.
 * The sample RFCs are the reason: one carried 33 images and 238 text
 * operations, so it uploads and parses "successfully" while saying almost
 * nothing. That has to reach the user as a warning, not as silence.
 */
const LOW_TEXT_THRESHOLD = 200;
const LOW_TEXT_PER_PAGE = 100;

export const WARNING_CODES = {
  LOW_EXTRACTED_TEXT: 'LOW_EXTRACTED_TEXT',
  NO_REQUIREMENTS_FOUND: 'NO_REQUIREMENTS_FOUND',
  AMBIGUOUS_REQUIREMENT: 'AMBIGUOUS_REQUIREMENT',
  CONFLICTING_SOURCES: 'CONFLICTING_SOURCES',
  PARSER_LIMITATION: 'PARSER_LIMITATION',
  UNREAD_IMAGE_CONTENT: 'UNREAD_IMAGE_CONTENT',
  DOCUMENT_FAILED: 'DOCUMENT_FAILED',
};

const PARSERS = {
  pdf: parsePdf,
  docx: parseDocx,
  xlsx: parseXlsx,
  transcription: parseTranscription,
};

/**
 * Half one of extraction: read the documents. Deterministic, no model, no network.
 *
 * Split from the structuring call so the public demo can do this part when a job is
 * submitted (and report an unreadable file to the person who uploaded it, at once),
 * free the uploaded buffers, and keep only the parsed blocks while the job waits for a
 * worker. extractDocuments() below is the two halves in sequence, as it always was.
 *
 * @param {Array<{filename: string, buffer: Buffer}>} files
 * @param {{ limits?: object }} [options]  parser ceilings; the configured ones by default
 * @returns {Promise<{documents: object[], parsedDocuments: object[], warnings: object[], startedAt: number}>}
 * @throws {AppError} NO_DOCUMENTS, or EXTRACTION_FAILED when no document could be read
 */
export async function parseDocuments(files, { limits } = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new AppError('NO_DOCUMENTS', 'No documents were uploaded.', 400);
  }

  setStage('EXTRACT');
  const startedAt = Date.now();
  trace('extraction_started', {
    file_count: files.length,
    file_sizes: files.map((file) => file.buffer?.length ?? 0),
  });

  const documents = [];
  const parsedDocuments = [];
  const warnings = [];

  for (const [index, file] of files.entries()) {
    const documentId = formatSequentialId(ID_PREFIX.document, index + 1);
    const filename = sanitizeFilename(file.filename);

    // The filename is metadata. Nothing downstream opens a path.
    const document = {
      document_id: documentId,
      filename,
      document_type: guessDocumentType(filename),
      mime_type: file.mimetype ?? null,
      size_bytes: file.buffer.length,
      page_count: null,
      extracted_char_count: null,
      status: 'Processing',
      error_message: null,
    };

    const parseStartedAt = Date.now();

    try {
      const fileType = detectFileType(file.buffer, filename);
      trace('parser_started', { document_id: documentId, file_type: fileType });
      const parsed = await PARSERS[fileType](file.buffer, documentId, limits);

      trace('parser_completed', {
        document_id: documentId,
        file_type: fileType,
        page_count: parsed.metrics.page_count ?? null,
        character_count: parsed.metrics.extracted_char_count,
        block_count: parsed.blocks?.length ?? 0,
        duration_ms: Date.now() - parseStartedAt,
      });

      document.page_count = parsed.metrics.page_count ?? null;
      document.extracted_char_count = parsed.metrics.extracted_char_count;
      document.status = 'Extracted';

      parsedDocuments.push(parsed);

      const lowText = describeLowText(parsed.metrics, fileType);
      if (lowText) {
        warnings.push({
          code: WARNING_CODES.LOW_EXTRACTED_TEXT,
          document_id: documentId,
          message: `${filename}: ${lowText}`,
        });
      }

      if (fileType === 'docx') {
        warnings.push({
          code: WARNING_CODES.PARSER_LIMITATION,
          document_id: documentId,
          message: `${filename}: DOCX has no fixed pagination, so source references cite the heading path instead of a page number.`,
        });
      }

      // Specification content the page carries as a picture. Named by page and
      // by the sentence that introduces it, so a reviewer can read what the
      // pipeline could not. Measured on the real PRD: the daily report format
      // is a raster table, and seventeen required columns, two stated formats,
      // a join key and a validation rule were absent from every coverage figure
      // this tool has produced for that document - with nothing saying so.
      const unread = (parsed.blocks ?? []).filter((block) => block.kind === 'image_region');
      if (unread.length > 0) {
        const where = unread
          .map((block) => `page ${block.page}${block.lead_in ? ` ("${block.lead_in}")` : ''}`)
          .join(', ');

        warnings.push({
          code: WARNING_CODES.UNREAD_IMAGE_CONTENT,
          document_id: documentId,
          message:
            `${filename} carries ${unread.length} image region(s) whose content is not in the PDF ` +
            `text layer and was not read: ${where}. If one of them states a requirement, nothing ` +
            `downstream has seen it - no obligation was derived from it and no coverage figure ` +
            `counts it. Read those regions and add what they require.`,
        });
      }

      // The same gap, declared by a person rather than found by the parser. A
      // transcription records what its verifier could not read, and that part
      // reached no requirement: nothing was guessed for it, so no obligation was
      // derived from it. Counted only in a metric nothing displays, a partial
      // transcription read as a complete one.
      for (const region of parsed.transcription?.regions ?? []) {
        if (!region.unreadable) continue;

        warnings.push({
          code: WARNING_CODES.UNREAD_IMAGE_CONTENT,
          document_id: documentId,
          message:
            `${filename}: the transcription of page ${region.page}` +
            `${region.lead_in ? ` ("${region.lead_in}")` : ''} records content ` +
            `${region.verified_by} could not read: "${region.unreadable}". Nothing was guessed ` +
            `for it - no obligation was derived from it and no coverage figure counts it. If it ` +
            `states a requirement, read that part of ${parsed.transcription.source_document} and ` +
            `add what it requires.`,
        });
      }
    } catch (cause) {
      // One bad document must not lose the others. It is reported, marked
      // Failed, and the rest of the batch continues.
      const message = cause instanceof AppError ? cause.message : 'The document could not be read.';

      trace('parser_failed', {
        document_id: documentId,
        error_class: cause?.constructor?.name ?? 'Error',
        error_code: cause?.code ?? null,
        // The controlled message only; a parser error can quote the file. The
        // filename is the uploader's text, so it is masked in the log.
        error_message: message.split(filename).join('[file]'),
        fail_soft: true,
        duration_ms: Date.now() - parseStartedAt,
      });

      document.status = 'Failed';
      document.error_message = message;
      document.extracted_char_count = 0;

      warnings.push({
        code: WARNING_CODES.DOCUMENT_FAILED,
        document_id: documentId,
        message: `${filename}: ${message}`,
      });
    }

    documents.push(document);
  }

  if (documents.every((document) => document.status === 'Failed')) {
    throw new AppError(
      'EXTRACTION_FAILED',
      documents.length === 1
        ? documents[0].error_message
        : 'None of the uploaded documents could be read.',
      422,
      documents.map((document) => ({
        document_id: document.document_id,
        filename: document.filename,
        message: document.error_message,
      }))
    );
  }

  return { documents, parsedDocuments, warnings, startedAt };
}

/** Explains a suspiciously low text yield, or returns null when it is fine. */
function describeLowText(metrics, fileType) {
  const characters = metrics.extracted_char_count ?? 0;

  if (characters === 0) {
    return fileType === 'pdf'
      ? 'no extractable text was found. The content is most likely images or scans; no OCR is performed, so nothing from this document has been used.'
      : 'no extractable text was found, so nothing from this document has been used.';
  }

  if (characters < LOW_TEXT_THRESHOLD) {
    return `only ${characters} characters of text were extracted. Content may be held in images, which are not read.`;
  }

  if (metrics.page_count > 1 && characters / metrics.page_count < LOW_TEXT_PER_PAGE) {
    return `only ${characters} characters across ${metrics.page_count} pages. Much of the content may be images, which are not read.`;
  }

  return null;
}
