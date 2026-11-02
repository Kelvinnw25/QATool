import { z } from 'zod';
import { REQUIREMENT_CATEGORIES } from './enums.js';
import { nonEmptyText, optionalText, sourceReferences } from './common.js';

/**
 * A conflict between documents (PRD 8). The system records both sides and
 * refuses to pick one - resolution is a human decision.
 */
export const requirementConflict = z
  .object({
    message: nonEmptyText(1000),
    source_references: sourceReferences,
    resolved: z.boolean().default(false),
    resolution_note: optionalText(1000),
  })
  .strict();

/**
 * REQ-001 is the only identifier. It is the handle test cases cite and the
 * middle link in the traceability chain:
 *
 *   Test Case -> Requirement -> Source Document -> Page / Section
 */
export const requirementSchema = z
  .object({
    requirement_id: z.string().regex(/^REQ-\d{3,}$/, 'Must be formatted as REQ-nnn.'),
    title: nonEmptyText(300),
    description: nonEmptyText(5000),
    category: z.enum(REQUIREMENT_CATEGORIES),
    source_references: sourceReferences,
    ambiguities: z.array(nonEmptyText(1000)).default([]),
    conflicts: z.array(requirementConflict).default([]),
  })
  .strict();
