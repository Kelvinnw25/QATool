import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createClientAddress } from './network.js';

const request = (remoteAddress, headers = {}) => ({ raw: { socket: { remoteAddress } }, headers });

describe('client address', () => {
  it('uses the socket peer when no proxy is trusted, whatever the headers claim', () => {
    const resolve = createClientAddress([]);
    const where = resolve(
      request('203.0.113.9', { 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8' })
    );
    assert.deepEqual(where, { peer: '203.0.113.9', client: '203.0.113.9' });
  });

  it('believes CF-Connecting-IP only from a trusted peer', () => {
    const resolve = createClientAddress(['172.18.0.1']);

    assert.deepEqual(resolve(request('172.18.0.1', { 'cf-connecting-ip': '198.51.100.7' })), {
      peer: '172.18.0.1',
      client: '198.51.100.7',
    });
    // The same header from anyone else is just text.
    assert.equal(
      resolve(request('172.18.0.99', { 'cf-connecting-ip': '198.51.100.7' })).client,
      '172.18.0.99'
    );
  });

  it('never reads X-Forwarded-For, even from a trusted peer', () => {
    const resolve = createClientAddress(['172.18.0.1']);
    const where = resolve(request('172.18.0.1', { 'x-forwarded-for': '198.51.100.7' }));
    assert.equal(where.client, '172.18.0.1');
  });

  it("ignores a trusted peer's header when it is not an IP address", () => {
    const resolve = createClientAddress(['172.18.0.1']);
    assert.equal(
      resolve(request('172.18.0.1', { 'cf-connecting-ip': 'evil\nheader' })).client,
      '172.18.0.1'
    );
    assert.equal(
      resolve(request('172.18.0.1', { 'cf-connecting-ip': 'localhost' })).client,
      '172.18.0.1'
    );
  });

  it('matches CIDR ranges and IPv4-mapped IPv6 peers', () => {
    const resolve = createClientAddress(['172.16.0.0/12']);
    assert.equal(
      resolve(request('::ffff:172.18.0.1', { 'cf-connecting-ip': '198.51.100.7' })).client,
      '198.51.100.7'
    );
    assert.equal(
      resolve(request('172.32.0.1', { 'cf-connecting-ip': '198.51.100.7' })).client,
      '172.32.0.1'
    );
  });

  it('copes with a missing socket address', () => {
    assert.equal(createClientAddress([])(request(undefined)).peer, 'unknown');
  });
});
