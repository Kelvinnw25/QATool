import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';

import { loadSecuritySettings } from '../settings.js';

/**
 * A stand-in for Cloudflare Access, for tests.
 *
 * Real RS256 keys and real signatures, so the verification under test is the real
 * one; only the source of the public key differs. `keys` is a jose local key set,
 * passed to buildApp() where the app would otherwise fetch Cloudflare's published
 * set. Nothing here touches the network.
 *
 * `token()` mints a token that is valid by default and can be made wrong in one
 * way at a time.
 */

export const TEAM_DOMAIN = 'qatool-test.cloudflareaccess.com';
export const AUDIENCE = 'aud-0123456789abcdef0123456789abcdef';
export const OWNER = 'owner@example.com';
export const ORIGIN = 'https://demo.example.com';

const encoder = new TextEncoder();
const base64url = (value) => Buffer.from(value).toString('base64url');

export async function createAccessFixture() {
  const signing = await generateKeyPair('RS256');
  const stranger = await generateKeyPair('RS256');
  const jwk = {
    ...(await exportJWK(signing.publicKey)),
    kid: 'test-key',
    alg: 'RS256',
    use: 'sig',
  };
  const keys = createLocalJWKSet({ keys: [jwk] });

  const now = () => Math.floor(Date.now() / 1000);

  /**
   * @param {object} [options]
   * @param {string | null} [options.email]      null leaves the claim out
   * @param {string} [options.issuer]
   * @param {string} [options.audience]
   * @param {number} [options.expiresAt]         seconds since the epoch
   * @param {number} [options.notBefore]
   * @param {'RS256' | 'HS256' | 'none'} [options.alg]
   * @param {boolean} [options.signedByStranger] valid shape, signed with another key
   * @param {string} [options.kid]
   */
  async function token({
    email = OWNER,
    issuer = `https://${TEAM_DOMAIN}`,
    audience = AUDIENCE,
    expiresAt = now() + 600,
    notBefore,
    alg = 'RS256',
    signedByStranger = false,
    kid = 'test-key',
  } = {}) {
    const claims = email === null ? {} : { email };

    if (alg === 'none') {
      const header = base64url(JSON.stringify({ alg: 'none', typ: 'JWT', kid }));
      const body = base64url(
        JSON.stringify({ ...claims, iss: issuer, aud: audience, exp: expiresAt, iat: now() })
      );
      return `${header}.${body}.`;
    }

    let jwt = new SignJWT(claims)
      .setProtectedHeader({ alg, kid, typ: 'JWT' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt(expiresAt < now() ? expiresAt - 600 : now())
      .setExpirationTime(expiresAt);
    if (notBefore !== undefined) jwt = jwt.setNotBefore(notBefore);

    const key =
      alg === 'HS256'
        ? encoder.encode('a-shared-secret-of-a-sensible-length-0123456789')
        : signedByStranger
          ? stranger.privateKey
          : signing.privateKey;
    return jwt.sign(key);
  }

  return { keys, token };
}

/** Public-mode settings with every required value present; override any of them. */
export function publicSecurity(overrides = {}) {
  return loadSecuritySettings({
    PUBLIC_MODE: 'true',
    ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
    ACCESS_AUD: AUDIENCE,
    OWNER_EMAILS: OWNER,
    ALLOWED_ORIGINS: ORIGIN,
    ...overrides,
  });
}
