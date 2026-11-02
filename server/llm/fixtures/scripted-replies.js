/**
 * Scripted answers to QATOOL's three real LLM calls, for tests that put a
 * gateway between the pipeline and the model.
 *
 * It reads the request the way a model would - block ids and requirement ids
 * out of the prompt, obligation ids out of the schema - so the same function
 * answers whatever document the pipeline was given. The wording is plainly
 * placeholder; the shapes are exactly what the three contracts require, which
 * is what a gateway that validates against the schema will check.
 *
 * Telling the calls apart by schema is how a provider can, and it keeps the
 * pipeline free of any hint that a test is running.
 */

function uniqueMatches(text, pattern) {
  return [...new Set(String(text ?? '').match(pattern) ?? [])];
}

function structureReply({ prompt }) {
  const blockIds = uniqueMatches(prompt, /\bDOC-\d{3,}-B\d{3,}\b/g);

  return {
    requirements: blockIds.map((blockId) => ({
      title: `Scripted requirement for ${blockId}`,
      source_block_ids: [blockId],
      test_points: [],
      ambiguous: false,
      conflicted: false,
      fragmented: false,
    })),
    supporting_blocks: [],
  };
}

function generationReply({ prompt, schema }) {
  const requirementIds = uniqueMatches(prompt, /\bREQ-\d{3,}\b/g);
  const obligationIds =
    schema.properties.obligation_plan?.items?.properties?.obligation_id?.enum ?? [];

  return {
    project: {
      project_description: 'Scripted project description for a gateway test.',
      project_summary: 'Scripted summary, produced without calling a language model.',
      qa_guidance: 'Scripted guidance. It reflects nothing in the uploaded documents.',
      sit_scope: [
        'Scripted Scope: Exercising the request path.',
        'Scripted Scope: Confirming the reply is validated.',
        'Scripted Scope: Confirming traceability is derived from requirements.',
      ],
      project_background: 'Scripted background for a gateway test. It describes no real project.',
    },
    ...(schema.properties.obligation_plan
      ? {
          obligation_plan: obligationIds.map((obligationId) => ({
            obligation_id: obligationId,
            status: 'insufficient_information',
            target_test_case_ids: [],
          })),
        }
      : {}),
    test_cases: requirementIds.map((requirementId, index) => ({
      ...(schema.properties.test_cases.items.properties.draft_id
        ? { draft_id: `T${index + 1}`, obligation_ids: [] }
        : {}),
      requirement_ids: [requirementId],
      section: `Scripted section for ${requirementId}`,
      test_case: `Verify the behaviour described by ${requirementId}.`,
      case_type: 'Positive',
      priority: 'Medium',
      type: 'Functional',
      expected_result: `Scripted expected result for ${requirementId}.`,
      confidence: 'Low',
      warnings: [],
    })),
    warnings: [],
  };
}

/**
 * @param {{prompt: string, schema: object}} request
 * @returns {object} an answer that satisfies request.schema
 */
export function scriptedReply(request) {
  const properties = request.schema?.properties ?? {};

  if (properties.issues) return { issues: [] };
  if (properties.requirements) return structureReply(request);
  if (properties.test_cases) return generationReply(request);

  throw new Error("scriptedReply was given a schema that is not one of QATOOL's three.");
}
