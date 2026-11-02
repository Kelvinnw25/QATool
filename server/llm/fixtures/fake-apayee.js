import http from 'node:http';

/**
 * A stand-in for Apayee's HTTP surface, on a loopback port, for tests.
 *
 * It speaks the documented contract (POST /v1/generate, the success and failure
 * envelopes, bearer authentication) and records every request, so a test can
 * assert what QATOOL put on the wire and script what comes back. It validates
 * nothing and queues nothing; the real gateway is exercised by the opt-in smoke
 * test, which needs the Apayee project and so cannot be part of `npm test`.
 */
export async function startFakeApayee({ prefix = '', token = null, reply } = {}) {
  const requests = [];
  const sockets = new Set();
  const closedByClient = [];

  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        // recorded as null; a test that cares asserts on `raw`
      }

      const record = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        raw,
        body,
      };
      requests.push(record);

      response.on('close', () => {
        if (!response.writableFinished) closedByClient.push(record);
      });

      if (request.url !== `${prefix}/v1/generate`) return send(response, 404, failure('NOT_FOUND'));
      if (token && request.headers.authorization !== `Bearer ${token}`) {
        return send(response, 401, failure('UNAUTHORIZED'));
      }

      try {
        await reply(record, response, { send, success, failure });
      } catch {
        if (!response.headersSent) send(response, 500, failure('INTERNAL_ERROR'));
      }
    });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}${prefix}`,
    port,
    requests,
    closedByClient,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(resolve);
      }),
  };
}

export function send(response, status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(text);
}

export function success(record, result, extra = {}) {
  return {
    request_id: record.body.request_id,
    status: 'success',
    provider: 'mock',
    result,
    metadata: {
      queue_wait_ms: 0,
      execution_time_ms: 1,
      total_time_ms: 1,
      usage: { input_tokens: 11, output_tokens: 22 },
    },
    ...extra,
  };
}

export function failure(code, extra = {}) {
  return {
    request_id: null,
    status: 'error',
    error: { code, message: `Fake message for ${code}.`, retryable: false },
    ...extra,
  };
}
