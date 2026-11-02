import { z } from 'zod';

import { TEST_POINT_TYPES } from './contract.js';

/**
 * Test points in transit.
 *
 * They are produced by Gemini #1 on the server, handed to the browser, and
 * posted back for Gemini #2 and #3. That round trip makes them untrusted input
 * like any other request body, so they are validated on the way back in and
 * pinned to requirements that actually exist.
 *
 * What a tampered test point can do is limited by design: it is prompt
 * guidance, nothing more. Case ids, source references, coverage arithmetic and
 * the canonical model are all system-owned and none of them reads this. The
 * worst outcome is worse advice to the generator, which the reviewer and QA
 * both see.
 */

export const testPointSchema = z
  .object({
    requirement_id: z.string().regex(/^REQ-\d{3,}$/),
    type: z.enum(TEST_POINT_TYPES).catch('behavior'),
    statement: z.string().trim().min(3).max(300),
  })
  .strict();

/** Enough to guide a generation, few enough to keep one prompt affordable. */
const MAX_TEST_POINTS = 200;

/**
 * Accepts test points posted by the browser, dropping anything unusable.
 *
 * Silent dropping is right here and nowhere else: an unparseable test point is
 * not content anyone loses, it is a hint that failed to make the trip. The
 * requirements and test cases it would have guided are untouched.
 *
 * @param {unknown} value            whatever arrived in the request body
 * @param {object[]} requirements    the requirements it must point at
 */
export function acceptTestPoints(value, requirements) {
  if (!Array.isArray(value)) return [];

  const known = new Set(requirements.map((requirement) => requirement.requirement_id));

  return value
    .map((entry) => testPointSchema.safeParse(entry))
    .filter((parsed) => parsed.success && known.has(parsed.data.requirement_id))
    .map((parsed) => parsed.data)
    .slice(0, MAX_TEST_POINTS);
}

/**
 * Renders test points for a prompt, grouped by requirement.
 *
 * Grouped because the model reads them beside the requirements and has to know
 * which one each belongs to, and because a flat list of a hundred lines reads
 * as a demand for a hundred test cases.
 *
 * @returns {string} '' when there is nothing to say
 */
export function testPointsForPrompt(testPoints) {
  if (!testPoints || testPoints.length === 0) return '';

  const grouped = new Map();
  for (const point of testPoints) {
    if (!grouped.has(point.requirement_id)) grouped.set(point.requirement_id, []);
    grouped.get(point.requirement_id).push(point);
  }

  const lines = [];
  for (const [requirementId, points] of grouped) {
    lines.push(`${requirementId}:`);
    for (const point of points) lines.push(`  - [${point.type}] ${point.statement}`);
  }

  return lines.join('\n');
}
