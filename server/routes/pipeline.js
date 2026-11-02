import {
  buildCoverage,
  canonicalProjectSchema,
  checkCanonicalReferences,
} from '../schema/canonical.js';
import { projectSchema } from '../schema/project.js';
import { collectIssues, parseOrThrow } from '../lib/validate.js';
import { AppError } from '../lib/errors.js';
import { exportFilename, exportSitScript } from '../export/sit-script-export.js';
import { extractDocuments } from '../extract/index.js';
import { generateFromRequirements } from '../generate/index.js';
import { reviewSemantics } from '../semantic/index.js';
import { diagnoseTestCases, skippedDiagnostics } from '../semantic/testcase-diagnostics.js';
import { config } from '../config.js';
import { parseProviderChoice, providerAvailability } from '../llm/catalog.js';
import { withClientCancellation } from '../lib/cancellation.js';
import { setStage, trace } from '../lib/trace.js';

/**
 * The stateless pipeline.
 *
 * Each endpoint is a pure function of its request body. The canonical project
 * lives in the browser for one session and is posted in on every call, so the
 * server keeps nothing between requests: no database, no session store, no
 * temporary files.
 *
 *   POST /api/extract   documents        -> documents + requirements + warnings
 *   POST /api/generate  requirements     -> project outputs + cases    (milestone 4)
 *   POST /api/validate  canonical        -> issues + coverage + test case diagnostics
 *   POST /api/export    canonical        -> SIT Script.xlsx
 *
 * The three routes that call a model take an optional `?provider=gemini|claude`.
 * Without it they behave exactly as before, using the server's configured
 * provider. With it, that choice is checked first and then used for the whole
 * request; nothing falls back to anything else. See chooseProvider().
 */
export default async function pipelineRoutes(fastify) {
  /**
   * Parses uploaded PDF/DOCX/XLSX into structured requirements.
   *
   * Files are read into memory with toBuffer() and never touch disk - there is
   * deliberately no call to saveRequestFiles(), and no upload directory in the
   * config for one to write to. The buffers are released when the request ends.
   */
  fastify.post('/api/extract', async (request, reply) => {
    if (!request.isMultipart()) {
      throw new AppError('BAD_REQUEST', 'Documents must be uploaded as multipart/form-data.', 400);
    }

    // Before any document is read: structuring absorbs a provider failure and
    // carries on with deterministic extraction, so a chosen provider that is not
    // there has to be refused here or the run would quietly become a different one.
    const provider = await chooseProvider(request);

    const files = [];

    try {
      for await (const part of request.files()) {
        files.push({
          filename: part.filename,
          mimetype: part.mimetype,
          buffer: await part.toBuffer(),
        });
      }
    } catch (cause) {
      if (cause.code === 'FST_REQ_FILE_TOO_LARGE') {
        throw new AppError(
          'FILE_TOO_LARGE',
          `A document exceeds the ${Math.floor(config.maxBodyBytes / (1024 * 1024))} MB limit.`,
          413
        );
      }
      if (cause.code === 'FST_FILES_LIMIT') {
        throw new AppError('TOO_MANY_FILES', 'Too many documents in one upload.', 413);
      }
      throw new AppError('UPLOAD_FAILED', 'The upload could not be read.', 400);
    }

    // The structuring call is the only part that waits on a model, so it is the
    // only part a disconnect can usefully stop.
    return withClientCancellation(request, reply, (signal) =>
      extractDocuments(files, { provider, signal })
    );
  });

  /**
   * Generates test cases and project-level content from extracted requirements.
   *
   * The input is the structured requirements, never raw document text: by this
   * point the uploaded buffers are long gone, and what the generator may work
   * from is exactly what extraction produced (PRD 10).
   *
   * Stateless like the rest of the pipeline - the canonical object is posted
   * in, the outputs are posted back, and a failure here leaves the browser's
   * copy of the requirements untouched so retry costs one call.
   */
  fastify.post('/api/generate', async (request, reply) => {
    const canonical = requireCanonical(request.body);
    const provider = await chooseProvider(request);
    return withClientCancellation(request, reply, (signal) =>
      generateFromRequirements(canonical, {
        testPoints: request.body?.test_points,
        provider,
        signal,
      })
    );
  });

  /**
   * Validation over the canonical object (PRD 15/16), in two tiers.
   *
   * Deterministic checks - schema, references, coverage - are authoritative
   * and always run. Semantic checks report concerns about meaning and never
   * block anything: heuristics always run, and the LLM review runs only when
   * asked for with ?semantic=true, so re-validating the sample workflow or a
   * page refresh never spends a model call by accident.
   *
   * Reports rather than throws: a project mid-workflow is usually incomplete,
   * and incomplete is not the same as broken. A failed LLM review is likewise
   * reported in `semantic.llm`, with the deterministic findings still returned,
   * so the review can be retried on its own without regenerating anything.
   */
  fastify.post('/api/validate', async (request, reply) => {
    const canonical = requireCanonical(request.body);

    // Checked even when no review is asked for, so a typo is a 400 everywhere;
    // but a model is only needed, and so only probed, for the semantic review.
    const useLlm = ['true', '1'].includes(String(request.query?.semantic ?? '').toLowerCase());
    const provider = await chooseProvider(request, { needsModel: useLlm });

    setStage('VALIDATE');
    trace('validation_started', {
      requirement_count: canonical.requirements?.length ?? 0,
      testcase_count: canonical.test_cases?.length ?? 0,
    });

    const schemaIssues = collectIssues(canonicalProjectSchema, canonical);
    const referenceIssues = schemaIssues.length === 0 ? checkCanonicalReferences(canonical) : [];
    const valid = schemaIssues.length === 0 && referenceIssues.length === 0;

    trace('traceability_completed', {
      valid,
      schema_issue_count: schemaIssues.length,
      reference_issue_count: referenceIssues.length,
    });

    const semantic = await withClientCancellation(request, reply, (signal) =>
      reviewSemantics(canonical, {
        useLlm,
        structurallyValid: valid,
        testPoints: request.body?.test_points,
        provider,
        signal,
      })
    );

    const coverage = valid ? buildCoverage(canonical) : emptyCoverage();

    // Diagnostics about the shape of each drafted case - non-atomic, vague,
    // intermediate-only. Advisory and separate: computed after everything above
    // and read from nothing above, so they cannot move a coverage figure, a
    // semantic warning or the workbook. Same structural gate as semantic checks.
    const testcaseDiagnostics = valid
      ? diagnoseTestCases(canonical)
      : skippedDiagnostics('Test case diagnostics run only on a structurally valid project.');

    trace('result_ready', {
      valid,
      semantic_warning_count: semantic.issues.length,
      requirements_covered: coverage.summary.requirement_covered,
      obligations_covered: coverage.summary.obligations_covered,
      obligations_total: coverage.summary.obligations_total,
    });

    return {
      valid,
      schema_issues: schemaIssues,
      reference_issues: referenceIssues,
      semantic_warnings: semantic.issues,
      semantic: semantic.status,
      coverage,
      testcase_diagnostics: testcaseDiagnostics,
    };
  });

  /**
   * Builds the SIT Script workbook and streams it back as a download.
   *
   * The exporter is unchanged from the spike: deterministic, in-memory, and it
   * verifies its own output before this route ever sees a buffer.
   */
  fastify.post('/api/export', async (request, reply) => {
    const canonical = requireCanonical(request.body);

    // Only the project name is needed, for the filename. The other project
    // outputs are Results-page content the workbook does not carry, so a flaw
    // in one of them must not block the artifact that matters.
    const projectName = parseOrThrow(
      projectSchema.shape.project_name,
      canonical.project?.project_name
    );

    if (canonical.test_cases.length === 0) {
      throw new AppError('EXPORT_EMPTY', 'There are no test cases to export.', 422);
    }

    const { buffer, rowCount, warnings } = exportSitScript(canonical.test_cases);
    const filename = exportFilename(projectName);

    reply
      .code(200)
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      // The filename is quoted and ASCII-safe via exportFilename, so a plain
      // filename= parameter is enough; no RFC 5987 encoding needed.
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .header('X-QATOOL-Row-Count', String(rowCount))
      // A count, not the notices themselves: the body is the workbook, and the
      // messages quote drafted values that need no business in a header. The
      // Results page already holds the per-case detail and renders it there.
      .header('X-QATOOL-Export-Warnings', String(warnings.length));

    return buffer;
  });
}

/**
 * The provider a request asked for, checked and ready to inject.
 *
 * No `provider` parameter returns undefined, and the stage then creates the
 * server's configured provider itself, as it always has - so existing callers,
 * and LLM_PROVIDER=apayee or mock deployments, are untouched. A parameter that
 * is not in the allowlist is a 400. A known one that cannot be used right now is
 * a 503 raised here, before the stage starts: never a silent switch to another
 * provider and never a degraded run. Nothing global is changed; the instance
 * belongs to this request.
 *
 * @param {import('fastify').FastifyRequest} request
 * @param {{ needsModel?: boolean }} [options] false when this request will not call a model
 * @returns {Promise<import('../llm/provider.js').LLMProvider | undefined>}
 */
async function chooseProvider(request, { needsModel = true } = {}) {
  const choice = parseProviderChoice(request.query?.provider);
  if (choice === null || !needsModel) return undefined;

  const provider = await providerAvailability.acquire(choice);
  trace('provider_selected', { provider_choice: choice });
  return provider;
}

/**
 * Coverage of a structurally invalid project cannot be trusted - a malformed
 * test case might not have a requirement_ids array to read - so it is reported
 * as empty rather than computed from bad data.
 */
function emptyCoverage() {
  return {
    entries: [],
    uncovered: [],
    orphan_test_cases: [],
    obligations: [],
    summary: {
      requirement_total: 0,
      requirement_covered: 0,
      requirement_partially_covered: 0,
      requirement_fully_covered: 0,
      obligations_total: 0,
      obligations_covered: 0,
      obligations_uncovered: 0,
      testcases_unresolved_classification: 0,
    },
  };
}

/**
 * Every pipeline endpoint takes the same envelope. Checking its shape here
 * keeps the error identical across endpoints instead of each one failing in its
 * own way on a malformed body.
 */
function requireCanonical(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(
      'BAD_REQUEST',
      'Expected a canonical project object in the request body.',
      400
    );
  }

  return {
    project: body.project ?? {},
    documents: Array.isArray(body.documents) ? body.documents : [],
    requirements: Array.isArray(body.requirements) ? body.requirements : [],
    test_cases: Array.isArray(body.test_cases) ? body.test_cases : [],
  };
}
