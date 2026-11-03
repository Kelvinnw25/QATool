import net from 'node:net';

/**
 * Who is on the other end of the socket.
 *
 * `CF-Connecting-IP` is a header: anyone who can reach the port can write it.
 * It is believed only when the TCP peer that delivered the request is on the
 * owner's list of trusted proxy peers (TRUSTED_PROXY_PEERS). With an empty list,
 * which is the default, the socket address is the only answer.
 *
 * X-Forwarded-For is never read. It is a list that every hop appends to and the
 * first hop is client-controlled, so there is no position in it that can be
 * trusted without knowing the whole chain.
 *
 * The result is for logs only. Nothing here grants or refuses access.
 */

/** "::ffff:10.0.0.1" is the IPv4 address 10.0.0.1 seen through a dual-stack socket. */
function normalisePeer(address) {
  const text = String(address ?? '');
  if (text === '') return 'unknown';
  return text.startsWith('::ffff:') && net.isIP(text.slice(7)) === 4 ? text.slice(7) : text;
}

const familyOf = (address) => (net.isIP(address) === 4 ? 'ipv4' : 'ipv6');

/**
 * @param {string[]} peers  addresses or CIDR ranges
 * @returns {(request: import('fastify').FastifyRequest) => { peer: string, client: string }}
 */
export function createClientAddress(peers = []) {
  const trusted = new net.BlockList();
  for (const entry of peers) {
    const [address, prefix] = entry.split('/');
    if (prefix === undefined) trusted.addAddress(address, familyOf(address));
    else trusted.addSubnet(address, Number(prefix), familyOf(address));
  }

  return (request) => {
    const peer = normalisePeer(request.raw?.socket?.remoteAddress);
    const claimed = request.headers['cf-connecting-ip'];

    const believed =
      peers.length > 0 &&
      typeof claimed === 'string' &&
      net.isIP(claimed.trim()) !== 0 &&
      net.isIP(peer) !== 0 &&
      trusted.check(peer, familyOf(peer));

    return { peer, client: believed ? claimed.trim() : peer };
  };
}
