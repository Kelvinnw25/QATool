/**
 * POST /api/session: a Turnstile token in, a short-lived ticket out.
 *
 * The one route a visitor can call without a ticket (`public`), and it is for a
 * browser page only (`browser`): the origin guard still applies. All the work is in
 * security/session.js; this is the HTTP shape.
 *
 *   request   { "turnstile_token": "<token from the widget>" }
 *   response  { "ticket": "<jwt>", "expires_at": "<iso>", "limits": {...}, "poll_interval_ms": n }
 *
 * The ticket goes back as `Authorization: Bearer <ticket>` on every other call. The
 * limits in the reply are the upload limits the page can check before it sends anything;
 * they are not secrets, and nothing about the provider or the server's setup is here.
 */
export default async function sessionRoutes(fastify) {
  const { limits, jobs } = fastify.security;

  fastify.post(
    '/api/session',
    { config: { public: true, browser: true } },
    async (request, reply) => {
      const body = request.body;
      const token = body !== null && typeof body === 'object' ? body.turnstile_token : undefined;

      const minted = await fastify.sessions.mint(request, token);

      reply.header('Cache-Control', 'no-store');
      return {
        ticket: minted.ticket,
        expires_at: new Date(minted.expiresAt).toISOString(),
        limits: {
          max_files: limits.uploadMaxFiles,
          max_file_bytes: limits.uploadMaxFileBytes,
          max_total_bytes: limits.uploadMaxTotalBytes,
        },
        poll_interval_ms: jobs.pollIntervalMs,
      };
    }
  );
}
