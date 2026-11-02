import { AppError } from '../lib/errors.js';
import { formatSequentialId, ID_PREFIX } from '../lib/ids.js';
import { detectFileType, guessDocumentType, sanitizeFilename } from './detect.js';
import { parsePdf } from './parsers/pdf.js';
import { parseDocx } from './parsers/docx.js';
import { parseXlsx } from './parsers/xlsx.js';
import { parseTranscription } from './parsers/transcription.js';
import { structureRequirements } from '../structure/index.js';
import { detectConflicts } from './conflicts.js';
import { recordFacts, recordTiming, setStage, trace } from '../lib/trace.js';

/**
 * The extraction pipeline.
 *
 * Buffers in, canonical documents and requirements out. Nothing is written to
 * disk and nothing is retained: the buffers are released when this function
 * returns, and the only thing that outlives it is the structured result the
 * browser holds for the session.
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
 * @param {Array<{filename: string, buffer: Buffer}>} files
 * @param {object} [options]
 * @param {import('../llm/provider.js').LLMProvider} [options.provider]  injected in tests
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{documents, requirements, test_points, criteria, warnings, structuring, metrics}>}
 */
export async function extractDocuments(files, { provider, signal } = {}) {
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
      const parsed = await PARSERS[fileType](file.buffer, documentId);

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
        // The controlled message only; a parser error can quote the file.
        error_message: message,
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

  // Gemini #1. The blocks never leave the server: they go to the structuring
  // call and the requirements come back rebuilt from them, so the browser
  // receives the same shape it always has. A provider failure falls back to
  // deterministic extraction rather than ending the workflow.
  const structured = await structureRequirements(documents, parsedDocuments, { provider, signal });
  const { requirements, testPoints, criteria } = structured;

  warnings.push(...structured.warnings);

  for (const conflict of detectConflicts(requirements)) {
    warnings.push({
      code: WARNING_CODES.CONFLICTING_SOURCES,
      document_id: null,
      message: `${conflict.message} Affects ${conflict.requirement_ids.join(', ')}.`,
    });
  }

  for (const requirement of requirements) {
    for (const ambiguity of requirement.ambiguities) {
      warnings.push({
        code: WARNING_CODES.AMBIGUOUS_REQUIREMENT,
        document_id: requirement.source_references[0]?.document_id ?? null,
        message: `${requirement.requirement_id}: ${ambiguity}`,
      });
    }
  }

  // PRD 22: never silently return an empty successful extraction. If the
  // documents parsed but yielded nothing, say so, and hand back the per
  // document metrics that explain why.
  if (requirements.length === 0) {
    throw new AppError(
      'NO_REQUIREMENTS_EXTRACTED',
      'The documents were read, but no requirement-like statements were found. They may be image-based, or may not contain testable statements.',
      422,
      documents.map((document) => ({
        document_id: document.document_id,
        filename: document.filename,
        status: document.status,
        extracted_char_count: document.extracted_char_count,
      }))
    );
  }

  recordTiming('extract', Date.now() - startedAt);
  // Key names avoid the safeFields denylist on purpose: `requirements` would be
  // dropped as potential content, `requirement_count` is a number and is not.
  recordFacts({
    files: documents.length,
    requirement_count: requirements.length,
  });
  trace('extraction_completed', {
    document_count: documents.length,
    failed_document_count: documents.filter((document) => document.status === 'Failed').length,
    requirement_count: requirements.length,
    test_point_count: testPoints.length,
    warning_count: warnings.length,
    duration_ms: Date.now() - startedAt,
  });

  return {
    documents,
    requirements,
    // AI guidance from the structuring call, held by the browser for the two
    // calls that follow. Deliberately outside the canonical project: it is
    // advice about what to test, not a fact about the project, and the
    // canonical schema stays strict.
    test_points: testPoints,
    criteria,
    structuring: structured.status,
    warnings,
    metrics: {
      document_count: documents.length,
      failed_document_count: documents.filter((document) => document.status === 'Failed').length,
      requirement_count: requirements.length,
      total_extracted_chars: documents.reduce(
        (sum, document) => sum + (document.extracted_char_count ?? 0),
        0
      ),
    },
  };
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
