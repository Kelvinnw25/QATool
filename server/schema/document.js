import { z } from 'zod';
import { DOCUMENT_STATUSES, DOCUMENT_TYPES } from './enums.js';
import { nonEmptyText, optionalText } from './common.js';

/**
 * An uploaded source document, as it exists during one workflow.
 *
 * There is deliberately no stored_path or checksum: uploads are parsed from the
 * request buffer and discarded. Nothing is written to disk, so there is no file
 * to point at and nothing whose integrity needs verifying later.
 *
 * DOC-001 is the only identifier, and it is also what source references cite.
 */
export const documentSchema = z
  .object({
    document_id: z.string().regex(/^DOC-\d{3,}$/, 'Must be formatted as DOC-nnn.'),
    filename: nonEmptyText(255),
    document_type: z.enum(DOCUMENT_TYPES),
    mime_type: optionalText(150),
    size_bytes: z.number().int().nonnegative().nullable().default(null),
    page_count: z.number().int().nonnegative().nullable().default(null),

    /**
     * Characters recovered by the parser. Surfaced so QA can spot a near-empty
     * parse: several of the sample RFCs carry their content in screenshots,
     * where a successful upload still yields almost no text.
     */
    extracted_char_count: z.number().int().nonnegative().nullable().default(null),

    status: z.enum(DOCUMENT_STATUSES).default('Uploaded'),
    error_message: optionalText(2000),
  })
  .strict();
