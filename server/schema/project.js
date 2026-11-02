import { z } from 'zod';
import { nonEmptyText, oneSentenceText, optionalText } from './common.js';

/**
 * Project-level AI outputs (PRD 17). Every one stays editable by QA, so none is
 * required and none is trusted.
 *
 * No id and no timestamps: the canonical project exists only for the duration
 * of one browser session and is never stored, so there is nothing to key it by.
 * Workflow position is wizard state in the frontend, not data.
 */
/**
 * Longest project_description the canonical model accepts, in characters. The
 * generation prompt and response schema quote this number, so a model is told
 * the limit it is held to.
 */
export const PROJECT_DESCRIPTION_MAX_LENGTH = 300;

export const projectSchema = z
  .object({
    project_name: nonEmptyText(200),

    /** Output 1: exactly one concise English sentence. */
    project_description: oneSentenceText(PROJECT_DESCRIPTION_MAX_LENGTH),

    project_summary: optionalText(4000),
    qa_guidance: optionalText(4000),
    project_background: optionalText(4000),
    sit_scope: z.array(nonEmptyText(500)).max(20).default([]),
  })
  .strict();
