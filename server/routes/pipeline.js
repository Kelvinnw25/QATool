import { projectSchema } from '../schema/project.js';
import { parseOrThrow } from '../lib/validate.js';
import { AppError } from '../lib/errors.js';
import { exportFilename, exportSitScript } from '../export/sit-script-export.js';
import { extractDocuments } from '../extract/index.js';
import { generateFromRequirements } from '../generate/index.js';
import { reviewSemantics } from '../semantic/index.js';
import { config } from '../config.js';
import { parseProviderChoice, providerAvailability } from '../llm/catalog.js';
import { withClientCancellation } from '../lib/cancellation.js';
import { trace } from '../lib/trace.js';
import { requireCanonical } from '../pipeline/canonical-input.js';
import { buildValidationReport, deterministicChecks } from '../pipeline/validation.js';
import { assertProviderAccess } from '../security/provider-policy.js';
import { readUploads } from '../security/uploads.js';

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
  // In the public demo every model call goes through the job manager (server/jobs/), whose
  // workers and queue are the only concurrency control. A direct route would bypass them, so
  // the two routes that always call a model are not registered there, and the validate route
  // refuses its semantic review (below). Deterministic validation and export stay.
  const demo = fastify.security?.demoMode === true;

  /**
   * Parses uploaded PDF/DOCX/XLSX into structured requirements.
   *
   * Files are read into memory with toBuffer() and never touch disk - there is
   * deliberately no call to saveRequestFiles(), and no upload directory in the
   * config for one to write to. The buffers are released when the request ends.
   */
  if (!demo) {
    fastify.post('/api/extract', { config: { model: 'always' } }, async (request, reply) => {
      if (!request.isMultipart()) {
        throw new AppError(
          'BAD_REQUEST',
          'Documents must be uploaded as multipart/form-data.',
          400
        );
      }

      // Before any document is read: structuring absorbs a provider failure and
      // carries on with deterministic extraction, so a chosen provider that is not
      // there has to be refused here or the run would quietly become a different one.
      const provider = await chooseProvider(request);

      // File count, per-file size and TOTAL size are enforced as the bytes arrive
      // (security/uploads.js). When one is crossed the connection is closed after
      // the reply, so the rest of an oversized upload is not read for nothing.
      let files;
      try {
        files = await readUploads(request, fastify.security?.limits ?? config.security.limits);
      } catch (error) {
        reply.header('Connection', 'close');
        throw error;
      }

      // The structuring call is the only part that waits on a model, so it is the
      // only part a disconnect can usefully stop.
      return runModelWork(fastify, request, reply, (signal) =>
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
    fastify.post('/api/generate', { config: { model: 'always' } }, async (request, reply) => {
      const canonical = requireCanonical(request.body);
      const provider = await chooseProvider(request);
      return runModelWork(fastify, request, reply, (signal) =>
        generateFromRequirements(canonical, {
          testPoints: request.body?.test_points,
          provider,
          signal,
        })
      );
    });
  }

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
  fastify.post('/api/validate', { config: { model: 'semantic' } }, async (request, reply) => {
    const canonical = requireCanonical(request.body);

    // Checked even when no review is asked for, so a typo is a 400 everywhere;
    // but a model is only needed, and so only probed, for the semantic review.
    const useLlm = ['true', '1'].includes(String(request.query?.semantic ?? '').toLowerCase());

    // The semantic review is a model call, and in the demo it belongs to a job. Refused
    // before a provider is chosen, so nothing is probed on its behalf.
    if (demo && useLlm) {
      throw new AppError(
        'USE_JOBS',
        'The semantic review runs as a job. Submit it with POST /api/jobs.',
        400
      );
    }

    const provider = await chooseProvider(request, { needsModel: useLlm });

    const checks = deterministicChecks(canonical);

    // Without ?semantic=true no model is involved, so the gate's concurrency
    // ceiling does not apply; the deadline and disconnect handling still do.
    const semantic = await runModelWork(
      fastify,
      request,
      reply,
      (signal) =>
        reviewSemantics(canonical, {
          useLlm,
          structurallyValid: checks.valid,
          testPoints: request.body?.test_points,
          provider,
          signal,
        }),
      { usesModel: useLlm }
    );

    return buildValidationReport(canonical, checks, semantic);
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

  // Defence in depth, before the gateway is asked anything: an explicit model
  // choice from anyone but the verified owner is refused (security/provider-policy.js).
  assertProviderAccess(request);

  const provider = await providerAvailability.acquire(choice);
  trace('provider_selected', { provider_choice: choice });
  return provider;
}

/**
 * Runs model work under the app's gate: client-disconnect cancellation, the
 * request deadline and the concurrency ceiling (security/gate.js). An instance
 * built without a gate keeps the original disconnect-only behaviour.
 */
function runModelWork(fastify, request, reply, work, options) {
  return fastify.modelGate
    ? fastify.modelGate.run(request, reply, work, options)
    : withClientCancellation(request, reply, work);
}
