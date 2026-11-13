import { request as httpRequest } from 'node:http';

/**
 * One `GET` over the backend's private Unix socket (server/ops/metrics-socket.js).
 *
 * This is how the monitoring container reads the backend: a socket FILE on a volume it mounts
 * read-only. It is not a network connection and not the Docker daemon socket. The answer is read with a
 * size limit and a deadline, and every failure becomes a short error with a fixed message; nothing the
 * socket sent is placed in an error.
 *
 * @param {string} socketPath
 * @param {'/snapshot' | '/apayee'} urlPath
 * @param {{ timeoutMs: number, request?: typeof httpRequest }} options  `request` is injected by tests
 * @returns {Promise<string>} the response body
 */
const MAX_BYTES = 64 * 1024;

const fail = (code, message) => Object.assign(new Error(message), { code });

export function readSocket(socketPath, urlPath, { timeoutMs, request = httpRequest }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      req.destroy();
      done(fail('SOCKET_TIMEOUT', 'The backend metrics socket did not answer in time.'));
    }, timeoutMs);

    const req = request({
      socketPath,
      path: urlPath,
      method: 'GET',
      headers: { accept: 'application/json' },
    });

    req.on('error', () =>
      done(
        fail(
          'SOCKET_UNREACHABLE',
          'The backend metrics socket is not reachable: the backend may still be starting, or ' +
            'OPS_METRICS_SOCKET is unset, or PUBLIC_DEMO is off.'
        )
      )
    );

    req.on('response', (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) {
          res.destroy();
          done(
            fail(
              'BAD_SNAPSHOT',
              'The backend answered with something that is not a valid snapshot.'
            )
          );
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          done(
            fail(
              'BAD_SNAPSHOT',
              'The backend answered with something that is not a valid snapshot.'
            )
          );
        } else {
          done(null, Buffer.concat(chunks).toString('utf8'));
        }
      });
      res.on('error', () => done(fail('BAD_SNAPSHOT', 'The backend answer was cut short.')));
    });

    req.end();
  });
}
