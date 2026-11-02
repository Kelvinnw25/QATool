import http from 'node:http';

/**
 * A stand-in for Apayee's health AND generate endpoints on a loopback port.
 *
 * fake-apayee.js speaks only POST /v1/generate. Choosing a model needs
 * GET /v1/health as well - the documented reply, including the `provider` name
 * that decides whether "Claude" is really behind the gateway - so this one
 * serves both, records every request, and lets a test script either answer.
 * Nothing here is a model: it never generates anything it was not told to say.
 *
 * `health` and `generate` are functions of the recorded request, so a test can
 * change what the gateway claims between calls (a restart with another
 * provider) by assigning to `gateway.health`.
 */

const sleepForever = () => new Promise(() => {});

/** The reply Apayee documents for GET /v1/health. */
export function healthReply({ provider = 'claude', status = 'ok', service = 'apayee' } = {}) {
  return {
    status: 200,
    body: {
      status,
      service,
      version: '0.1.0',
      provider,
      queue: { length: 0, running: false, capacity: 16, abandoned: 0, totals: {} },
    },
  };
}

/** The success envelope Apayee documents for POST /v1/generate. */
export function generateReply(requestId, result, { provider = 'claude' } = {}) {
  return {
    status: 200,
    body: {
      request_id: requestId,
      status: 'success',
      provider,
      result,
      metadata: { queue_wait_ms: 0, execution_time_ms: 1, total_time_ms: 1 },
    },
  };
}

export async function startFakeGateway({ token = null, provider = 'claude', generate } = {}) {
  const requests = [];
  const sockets = new Set();

  const gateway = {
    requests,
    /** Called for GET /v1/health; return {status, body}, or 'hang' to never answer. */
    health: () => healthReply({ provider }),
    /** Called for POST /v1/generate with the parsed body. */
    generate: generate ?? ((record) => generateReply(record.body.request_id, {}, { provider })),
  };

  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        // recorded as null
      }

      const record = { method: request.method, url: request.url, headers: request.headers, body };
      requests.push(record);

      const send = (status, payload) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
      };

      if (token && request.headers.authorization !== `Bearer ${token}`) {
        return send(401, { status: 'error', error: { code: 'UNAUTHORIZED' } });
      }

      if (request.method === 'GET' && request.url === '/v1/health') {
        const reply = await gateway.health(record);
        if (reply === 'hang') return sleepForever();
        return send(reply.status, reply.body);
      }

      if (request.method === 'POST' && request.url === '/v1/generate') {
        const reply = await gateway.generate(record);
        return send(reply.status, reply.body);
      }

      return send(404, { status: 'error', error: { code: 'NOT_FOUND' } });
    });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return Object.assign(gateway, {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    /** Requests of one kind, e.g. gateway.count('GET', '/v1/health'). */
    count: (method, url) =>
      requests.filter((record) => record.method === method && record.url === url).length,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(resolve);
      }),
  });
}

/** A loopback port with nothing listening on it. */
export async function closedPort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
