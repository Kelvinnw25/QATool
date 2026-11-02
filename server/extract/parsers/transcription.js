import { z } from 'zod';
import { AppError } from '../../lib/errors.js';

/**
 * A human-authored transcription of PDF regions that are pictures.
 *
 * The problem this solves, measured on a real PRD: page 6 says "Report format
 * to be generated as shown below:" and then supplies the format as a raster
 * table. Seventeen required report columns, two stated formats, a join key and
 * a validation rule exist only as pixels - proven by three independent checks,
 * the strongest being that TRX_DATE and v_qr_release_settlement appear nowhere
 * in the raw PDF bytes. The pipeline could not see any of it.
 *
 * The two obvious fixes both break the one guarantee this tool rests on. OCR
 * makes a decoder the author of requirement text; a vision model makes the LLM
 * the author. In a tool whose contract is "the model cites block ids and the
 * SYSTEM rebuilds the text verbatim", either turns a misread character into a
 * fabricated banking requirement carrying full provenance.
 *
 * So the transcription comes from a person. They read the image, they write it
 * down, they put their name on it, and QATOOL records who said so. Nothing is
 * guessed and nothing is decoded: the trust boundary moves from "the document"
 * to "the document plus a named human", which is a boundary a bank can audit.
 *
 * What this is NOT:
 *
 *   not OCR              no decoder runs, and none is a dependency
 *   not model output     Gemini never sees the pixels and never writes source text
 *   not silent           every block it produces is marked image_transcription,
 *                        carries its page, and names who verified it - it is
 *                        never presented as verbatim PDF text
 *   not a way in for samples   specimen values are declared separately and are
 *                        deliberately kept out of the blocks, so a sample FT
 *                        number cannot become a rule
 */

const regionSchema = z
  .object({
    page: z.number().int().positive(),
    lead_in: z.string().max(300).optional(),
    verified_by: z.string().min(1).max(120),
    /** The contract, one line per row or statement, as the person read it. */
    contract: z.array(z.string().min(1).max(500)).min(1).max(200),
    /**
     * Specimen values seen in the image. Recorded so a reviewer can see what was
     * deliberately NOT carried across, and never turned into blocks.
     */
    samples: z.array(z.string().max(200)).max(200).optional(),
    /** Anything the person could not read. Reported rather than guessed. */
    unreadable: z.string().max(500).optional(),
  })
  .strict();

const sidecarSchema = z
  .object({
    qatool_image_transcription: z.literal(1),
    source_document: z.string().min(1).max(255),
    regions: z.array(regionSchema).min(1).max(50),
  })
  .strict();

/** The marker that identifies this file, checked before anything is parsed. */
export const TRANSCRIPTION_MARKER = 'qatool_image_transcription';

/**
 * Whether a buffer is one of these files.
 *
 * Deliberately strict and cheap: the marker must be present in the first part
 * of the file, so an ordinary JSON upload is not mistaken for a transcription.
 */
export function looksLikeTranscription(buffer) {
  if (buffer.length < 2 || buffer.length > 2_000_000) return false;

  const head = buffer.subarray(0, Math.min(buffer.length, 4096)).toString('utf8');
  return head.trimStart().startsWith('{') && head.includes(TRANSCRIPTION_MARKER);
}

export async function parseTranscription(buffer, documentId) {
  let parsed;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch (cause) {
    throw new AppError(
      'PARSER_FAILURE',
      `The transcription file is not valid JSON: ${cause.message}`,
      422
    );
  }

  const result = sidecarSchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new AppError(
      'PARSER_FAILURE',
      `The transcription file is not in the expected shape: ${first.path.join('.')} ${first.message}.`,
      422
    );
  }

  const sidecar = result.data;
  const blocks = [];
  let characterCount = 0;

  for (const region of sidecar.regions) {
    for (const line of region.contract) {
      characterCount += line.length;

      blocks.push({
        kind: 'image_transcription',
        text: line,
        level: null,
        page: region.page,
        section: region.lead_in ?? null,
        sheet: null,
        cell: null,
        table: null,
        // Provenance travels with every block. Downstream code and every
        // reviewer can tell at a glance that this text was read off a picture
        // by a named person rather than lifted from a text layer.
        provenance: 'image_transcription',
        verified_by: region.verified_by,
        transcribed_from: sidecar.source_document,
      });
    }
  }

  return {
    blocks,
    metrics: {
      page_count: null,
      extracted_char_count: characterCount,
      transcribed_region_count: sidecar.regions.length,
      // Counted, never blocked. A reviewer can see how much was set aside.
      declared_sample_count: sidecar.regions.reduce(
        (total, region) => total + (region.samples?.length ?? 0),
        0
      ),
      unreadable_regions: sidecar.regions.filter((region) => region.unreadable).length,
    },
    documentId,
    transcription: sidecar,
  };
}
