import { AppError } from '../lib/errors.js';
import { structureRequirements } from '../structure/index.js';
import { detectConflicts } from './conflicts.js';
import { parseDocuments, WARNING_CODES } from './parse.js';
import { recordFacts, recordTiming, trace } from '../lib/trace.js';

// Reading the documents lives in parse.js (so a worker thread can load it without the
// model code); these keep the names this module has always exported.
export { parseDocuments, WARNING_CODES };

/**
 * The extraction pipeline.
 *
 * Buffers in, canonical documents and requirements out. Nothing is written to
 * disk and nothing is retained: the buffers are released when this function
 * returns, and the only thing that outlives it is the structured result the
 * browser holds for the session.
 */

/**
 * Half two of extraction: the structuring call and everything built from it.
 *
 * @param {{documents: object[], parsedDocuments: object[], warnings: object[], startedAt?: number}} parsed
 *   what parseDocuments() returned
 * @param {object} [options]
 * @param {import('../llm/provider.js').LLMProvider} [options.provider]  injected in tests
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{documents, requirements, test_points, criteria, warnings, structuring, metrics}>}
 */
export async function structureParsed(parsed, { provider, signal } = {}) {
  const { documents, parsedDocuments, startedAt = Date.now() } = parsed;
  // Copied, so running this twice on one parse result cannot double the warnings.
  const warnings = [...parsed.warnings];

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

/**
 * @param {Array<{filename: string, buffer: Buffer}>} files
 * @param {object} [options]
 * @param {import('../llm/provider.js').LLMProvider} [options.provider]  injected in tests
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{documents, requirements, test_points, criteria, warnings, structuring, metrics}>}
 */
export async function extractDocuments(files, { provider, signal } = {}) {
  return structureParsed(await parseDocuments(files), { provider, signal });
}
