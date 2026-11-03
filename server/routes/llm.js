import { providerAvailability } from '../llm/catalog.js';
import { publicProviderList } from '../security/public-errors.js';

/**
 * Which models a run can choose between, and whether each can be used now.
 *
 * Read-only and free of secrets: an id, a label, a yes/no and a reason written
 * for the person at the screen. The gateway's address, the token and the key are
 * never part of the answer, and nothing here calls a model.
 *
 * In public mode the reasons are reduced to two phrases ("not configured", "not
 * available right now"), because the full ones describe the gateway's state:
 * offline, rejecting credentials, running its mock provider. That is useful at the
 * terminal and a map of the setup anywhere else. The route itself needs the owner's
 * Access token like every other API route.
 */
export default async function llmRoutes(fastify) {
  fastify.get('/api/llm/providers', async (request, reply) => {
    // Availability is a moment-in-time answer; a browser must not reuse it.
    reply.header('Cache-Control', 'no-store');

    const list = await providerAvailability.list();
    return fastify.security?.publicMode ? publicProviderList(list) : list;
  });
}
