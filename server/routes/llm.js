import { providerAvailability } from '../llm/catalog.js';

/**
 * Which models a run can choose between, and whether each can be used now.
 *
 * Read-only and free of secrets: an id, a label, a yes/no and a reason written
 * for the person at the screen. The gateway's address, the token and the key are
 * never part of the answer, and nothing here calls a model.
 */
export default async function llmRoutes(fastify) {
  fastify.get('/api/llm/providers', async (request, reply) => {
    // Availability is a moment-in-time answer; a browser must not reuse it.
    reply.header('Cache-Control', 'no-store');
    return providerAvailability.list();
  });
}
