import { AppError } from '../lib/errors.js';

/**
 * Who may name a model.
 *
 * Claude runs on the owner's personal subscription through Apayee, so it is never
 * a public feature, and the rule is enforced here on the server rather than by
 * hiding a button. In public mode every API route already requires the owner's
 * Access token (access.js) and sets `request.identity`; this is the second,
 * independent check at the point where a provider is actually chosen, before the
 * gateway is asked anything. If the first check were ever bypassed, an explicit
 * `?provider=` from anyone but the owner still stops here.
 *
 * Outside public mode there is no identity and nothing changes.
 *
 * The other half of the rule is configuration: a server-wide default of Apayee is
 * refused at startup in public mode (settings.js), so a request that names no
 * provider can never reach it either.
 *
 * @param {{ server?: { security?: { publicMode?: boolean } }, identity?: { owner?: boolean } | null }} request
 * @throws {AppError} FORBIDDEN
 */
export function assertProviderAccess(request) {
  if (request.server?.security?.publicMode && request.identity?.owner !== true) {
    throw new AppError('FORBIDDEN', 'This account may not choose a model.', 403);
  }
}
