import {
  CASE_TYPES,
  CONFIDENCE_LEVELS,
  DEFAULT_TEST_TYPE,
  DOCUMENT_TYPES,
  EDGE_POLARITIES,
  EXECUTION_STATUSES,
  OBSERVED_TEST_TYPES,
  PRIORITIES,
  REQUIREMENT_CATEGORIES,
  TEMPLATE_CASE_TYPES,
  TEST_TYPE_MAX_LENGTH,
} from '../schema/enums.js';
import { buildSampleCanonical } from '../export/fixtures/sample-canonical.js';

/**
 * Describes the controlled vocabularies the pipeline will accept.
 *
 * The batch UI no longer renders editable dropdowns, so nothing in the frontend
 * consumes this any more. It is kept because it is the one place to look when
 * asking what values the tool accepts, and it costs nothing to serve.
 */
export default async function metaRoutes(fastify) {
  fastify.get('/api/health', async () => ({
    status: 'ok',
    stateless: true,
    time: new Date().toISOString(),
  }));

  /**
   * A complete sample workflow, so the review, validation and export stages can
   * be exercised before extraction and generation exist.
   *
   * Scaffolding - remove once /api/extract and /api/generate are implemented.
   */
  fastify.get('/api/meta/sample-canonical', async () => buildSampleCanonical());

  fastify.get('/api/meta/enums', async () => ({
    case_types: CASE_TYPES,
    template_case_types: TEMPLATE_CASE_TYPES,
    edge_polarities: EDGE_POLARITIES,
    priorities: PRIORITIES,

    // Type is a free-text controlled string, not an enum. These are
    // suggestions for the UI to offer; any non-empty value is accepted.
    test_type: {
      free_text: true,
      default: DEFAULT_TEST_TYPE,
      suggestions: OBSERVED_TEST_TYPES,
      max_length: TEST_TYPE_MAX_LENGTH,
    },

    execution_statuses: EXECUTION_STATUSES,
    confidence_levels: CONFIDENCE_LEVELS,
    requirement_categories: REQUIREMENT_CATEGORIES,
    document_types: DOCUMENT_TYPES,
  }));
}
